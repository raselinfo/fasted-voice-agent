import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { analyzePcm16Mono, createPcm16Wav } from "./audio-analysis.mjs";
import {
  createTtsPlan,
  DEFAULT_TTS_BASELINE_JSON_PATH,
  DEFAULT_TTS_BASELINE_MD_PATH,
  DEFAULT_TTS_PROMPT_SET_PATH,
  deriveSuggestedGainDb,
  loadTtsPromptSet,
  renderTtsMarkdown,
  summariseTtsRuns,
} from "./tts-benchmark.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const DEFAULT_PROBE_URL = process.env.PROVIDER_BENCH_URL ?? "http://127.0.0.1:8791";
const DEFAULT_OUTPUT_DIR = process.env.PROVIDER_BENCH_OUTPUT_DIR ?? ".planning/quick/260410-tts-loudness-baseline";
const OUTPUT_STEM = "260410-tts-loudness-results";
const GROQ_ORPHEUS_CHAR_LIMIT = 200;
const GROQ_ORPHEUS_MIN_INTERVAL_MS = 6500;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    sampleCount: 3,
    probeUrl: DEFAULT_PROBE_URL,
    outputDir: resolve(ROOT, DEFAULT_OUTPUT_DIR),
    promptSetPath: resolve(ROOT, DEFAULT_TTS_PROMPT_SET_PATH),
    baselineJsonPath: resolve(ROOT, DEFAULT_TTS_BASELINE_JSON_PATH),
    baselineMarkdownPath: resolve(ROOT, DEFAULT_TTS_BASELINE_MD_PATH),
    orpheusHeadToHead: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") options.dryRun = true;
    else if (token === "--sample-count") options.sampleCount = Number(argv[++index]);
    else if (token.startsWith("--sample-count=")) options.sampleCount = Number(token.split("=")[1]);
    else if (token === "--probe-url") options.probeUrl = argv[++index];
    else if (token.startsWith("--probe-url=")) options.probeUrl = token.split("=")[1];
    else if (token === "--output-dir") options.outputDir = resolve(ROOT, argv[++index]);
    else if (token.startsWith("--output-dir=")) options.outputDir = resolve(ROOT, token.split("=")[1]);
    else if (token === "--prompt-set") options.promptSetPath = resolve(ROOT, argv[++index]);
    else if (token.startsWith("--prompt-set=")) options.promptSetPath = resolve(ROOT, token.split("=")[1]);
    else if (token === "--baseline-json") options.baselineJsonPath = resolve(ROOT, argv[++index]);
    else if (token.startsWith("--baseline-json=")) options.baselineJsonPath = resolve(ROOT, token.split("=")[1]);
    else if (token === "--baseline-md") options.baselineMarkdownPath = resolve(ROOT, argv[++index]);
    else if (token.startsWith("--baseline-md=")) options.baselineMarkdownPath = resolve(ROOT, token.split("=")[1]);
    else if (token === "--orpheus-head-to-head") options.orpheusHeadToHead = true;
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function readRetryDelayMs(errorMessage) {
  const match = /try again in (\d+)s/i.exec(errorMessage ?? "");
  if (!match) return null;
  return (Number(match[1]) + 1) * 1000;
}

function decodeBase64(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

async function ensureFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`ffmpeg is required for loudness measurement: ${cause}`);
  }
}

async function measureLoudnessWithFfmpeg(pcmBytes, sampleRate) {
  const tempDir = await mkdtemp(join(tmpdir(), "voice-agent-tts-loudness-"));
  const wavPath = join(tempDir, "sample.wav");

  const lastCapturedNumber = (pattern, text) => {
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) {
      return null;
    }
    return Number(matches.at(-1)[1]);
  };

  try {
    await writeFile(wavPath, createPcm16Wav(pcmBytes, sampleRate));
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-i",
      wavPath,
      "-filter_complex",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ]);

    return {
      integratedLoudnessLufs: lastCapturedNumber(/^\s*I:\s*([-\d.]+)\s+LUFS/igm, stderr),
      loudnessRangeLu: lastCapturedNumber(/^\s*LRA:\s*([-\d.]+)\s+LU/igm, stderr),
      truePeakDbfs: lastCapturedNumber(/^\s*Peak:\s*([-\d.]+)\s+dBFS/igm, stderr),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

let lastGroqOrpheusCallAt = 0;

async function maybeThrottleProvider(payload) {
  if (payload.provider !== "groq-orpheus") return;
  const now = Date.now();
  const waitMs = Math.max(0, GROQ_ORPHEUS_MIN_INTERVAL_MS - (now - lastGroqOrpheusCallAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastGroqOrpheusCallAt = Date.now();
}

async function invokeProbe(probeUrl, payload, attempt = 0) {
  await maybeThrottleProvider(payload);
  const response = await fetch(`${probeUrl}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (response.ok) return body;

  const errorMessage = body.error ?? response.statusText;
  const retryDelayMs = response.status === 429 ? readRetryDelayMs(errorMessage) : null;
  if (retryDelayMs !== null && attempt < 5) {
    await sleep(retryDelayMs);
    return invokeProbe(probeUrl, payload, attempt + 1);
  }

  throw new Error(errorMessage);
}

async function enrichRunMetrics(run) {
  if (typeof run.pcmBase64 !== "string" || typeof run.sampleRate !== "number") {
    throw new Error(`Missing pcmBase64/sampleRate for ${run.provider}:${run.model}.`);
  }

  const pcmBytes = decodeBase64(run.pcmBase64);
  const analysis = analyzePcm16Mono(pcmBytes, run.sampleRate);
  const loudness = await measureLoudnessWithFfmpeg(pcmBytes, run.sampleRate);

  return {
    ...run,
    ...analysis,
    ...loudness,
  };
}

const options = parseArgs(process.argv.slice(2));
const prompts = await loadTtsPromptSet(options.promptSetPath);
const plan = createTtsPlan({ orpheusHeadToHead: options.orpheusHeadToHead });
const usablePrompts = options.orpheusHeadToHead
  ? prompts.filter((prompt) => prompt.text.length <= GROQ_ORPHEUS_CHAR_LIMIT)
  : prompts;

if (usablePrompts.length === 0) {
  throw new Error("No benchmark prompts remain after applying provider constraints.");
}

if (options.dryRun) {
  console.log(JSON.stringify({
    kind: "tts-bench-dry-run",
    probeUrl: options.probeUrl,
    outputDir: options.outputDir,
    promptSetPath: options.promptSetPath,
    sampleCount: options.sampleCount,
    prompts: usablePrompts,
    plan,
  }, null, 2));
  process.exit(0);
}

await ensureFfmpeg();

const runMap = new Map(plan.map((item) => [`${item.provider}:${item.model}`, []]));

for (const item of plan) {
  await invokeProbe(options.probeUrl, {
    provider: item.provider,
    model: item.model,
    voice: item.voice,
    text: usablePrompts[0].text,
    captureAudio: true,
  });
}

for (let round = 0; round < options.sampleCount; round += 1) {
  for (const prompt of usablePrompts) {
    for (const item of plan) {
      const rawRun = await invokeProbe(options.probeUrl, {
        provider: item.provider,
        model: item.model,
        voice: item.voice,
        text: prompt.text,
        captureAudio: true,
      });
      const enrichedRun = await enrichRunMetrics({
        ...rawRun,
        promptId: prompt.id,
        promptLabel: prompt.label,
      });
      runMap.get(`${item.provider}:${item.model}`).push(enrichedRun);
    }
  }
}

const summaries = plan.map((item) => {
  const runs = runMap.get(`${item.provider}:${item.model}`);
  return {
    provider: item.provider,
    model: item.model,
    voice: item.voice ?? null,
    label: item.label ?? item.model,
    sampleCount: runs.length,
    ...summariseTtsRuns(runs),
    runs,
  };
});

const { targetSpeechRmsDbfs, suggestedGainByKey } = deriveSuggestedGainDb(summaries);
const results = summaries.map((summary) => ({
  ...summary,
  suggestedGainDbToMedianSpeechRms: suggestedGainByKey[`${summary.provider}:${summary.model}`] ?? null,
}));

const baselinePayload = {
  generatedAt: new Date().toISOString(),
  probeUrl: options.probeUrl,
  promptSetPath: options.promptSetPath,
  promptCount: usablePrompts.length,
  prompts: usablePrompts,
  sampleCount: options.sampleCount,
  targetSpeechRmsDbfs,
  plan,
  results,
};

await mkdir(options.outputDir, { recursive: true });
await mkdir(dirname(options.baselineJsonPath), { recursive: true });
await mkdir(dirname(options.baselineMarkdownPath), { recursive: true });

const markdown = renderTtsMarkdown(results, {
  probeUrl: options.probeUrl,
  promptSetPath: options.promptSetPath,
  sampleCount: options.sampleCount,
  targetSpeechRmsDbfs,
});

await writeFile(resolve(options.outputDir, `${OUTPUT_STEM}.json`), JSON.stringify(baselinePayload, null, 2));
await writeFile(resolve(options.outputDir, `${OUTPUT_STEM}.md`), markdown);
await writeFile(options.baselineJsonPath, JSON.stringify(baselinePayload, null, 2));
await writeFile(options.baselineMarkdownPath, markdown);

console.log(JSON.stringify(baselinePayload, null, 2));
