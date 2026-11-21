import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const DEFAULT_PROBE_URL = process.env.PROVIDER_BENCH_URL ?? 'http://127.0.0.1:8791';
const DEFAULT_OUTPUT_DIR = process.env.PROVIDER_BENCH_OUTPUT_DIR ?? '.planning/quick/260405-x9v-benchmark-all-provider-swap-options-for-';
const MANIFEST_PATH = resolve(ROOT, 'scripts/provider-bench/corpus-manifest.jsonl');
const OUTPUT_STEM = '260405-x9v-turn-results';

function parseArgs(argv) {
  const options = { dryRun: false, limit: 4, sampleCount: 2, probeUrl: DEFAULT_PROBE_URL, outputDir: resolve(ROOT, DEFAULT_OUTPUT_DIR) };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') options.dryRun = true;
    else if (token === '--limit') options.limit = Number(argv[++i]);
    else if (token.startsWith('--limit=')) options.limit = Number(token.split('=')[1]);
    else if (token === '--sample-count') options.sampleCount = Number(argv[++i]);
    else if (token.startsWith('--sample-count=')) options.sampleCount = Number(token.split('=')[1]);
    else if (token === '--probe-url') options.probeUrl = argv[++i];
    else if (token.startsWith('--probe-url=')) options.probeUrl = token.split('=')[1];
    else if (token === '--output-dir') options.outputDir = resolve(ROOT, argv[++i]);
    else if (token.startsWith('--output-dir=')) options.outputDir = resolve(ROOT, token.split('=')[1]);
  }
  return options;
}

function readJsonLines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function findChunk(buffer, chunkId) {
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === chunkId) {
      return { offset: offset + 8, size };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function readWavPcm(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected RIFF/WAVE PCM input');
  }
  const fmt = findChunk(buffer, 'fmt ');
  const data = findChunk(buffer, 'data');
  if (!fmt || !data) {
    throw new Error('Missing WAV fmt/data chunk');
  }

  const format = buffer.readUInt16LE(fmt.offset);
  const channels = buffer.readUInt16LE(fmt.offset + 2);
  const sampleRate = buffer.readUInt32LE(fmt.offset + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.offset + 14);
  if (format !== 1 || bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV format ${format}/${bitsPerSample}`);
  }

  const samples = new Int16Array(
    buffer.buffer,
    buffer.byteOffset + data.offset,
    Math.floor(data.size / 2),
  );

  return { channels, sampleRate, samples };
}

function estimateSpeechEndMsFromPcm(buffer) {
  const { channels, sampleRate, samples } = readWavPcm(buffer);
  const windowMs = 20;
  const frameSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const minRms = 550;
  let lastActiveFrame = null;

  for (let offset = 0, frameIndex = 0; offset < samples.length; offset += frameSamples * channels, frameIndex += 1) {
    let sumSquares = 0;
    let count = 0;
    for (let i = offset; i < Math.min(samples.length, offset + frameSamples * channels); i += channels) {
      const value = samples[i];
      sumSquares += value * value;
      count += 1;
    }
    if (!count) continue;
    const rms = Math.sqrt(sumSquares / count);
    if (rms >= minRms) {
      lastActiveFrame = frameIndex;
    }
  }

  if (lastActiveFrame === null) {
    return 0;
  }

  return Math.round((lastActiveFrame + 1) * windowMs);
}

function selectTurnEntries(entries, limit) {
  const scored = entries
    .map((entry) => ({
      entry,
      score:
        (entry.tags?.includes('clean-eot') ? 4 : 0) +
        (entry.tags?.includes('single-speaker') ? 2 : 0) +
        (!entry.tags?.includes('follow-up-window') ? 1 : 0) +
        (!entry.tags?.includes('laughter-nearby') ? 1 : 0) +
        (!entry.tags?.includes('short') ? 2 : -2) +
        (!entry.tags?.includes('filler') ? 1 : -1) +
        ((entry.clipEndMs - entry.clipStartMs) >= 4500 ? 2 : -4) +
        ((entry.clipEndMs - entry.clipStartMs) - entry.speechEndMs >= 1200 ? 2 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map(({ entry }) => entry);

  return scored;
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function invokeProbe(probeUrl, payload) {
  const response = await fetch(`${probeUrl}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

async function loadClipBase64(audioPath) {
  const buffer = await readFile(resolve(ROOT, audioPath));
  return {
    audioBase64: buffer.toString('base64'),
    estimatedSpeechEndMs: estimateSpeechEndMsFromPcm(buffer),
  };
}

function summariseRuns(runs) {
  const eot = runs.map((run) => run.speechEndToEndOfTurnMs).filter((value) => typeof value === 'number');
  const eagerLead = runs.map((run) => run.eagerEndOfTurnToEndOfTurnMs).filter((value) => typeof value === 'number');
  return {
    completionCount: eot.length,
    completionRate: runs.length ? Number((eot.length / runs.length).toFixed(3)) : 0,
    speechEndToEndOfTurnMs: eot.length ? { min: Math.min(...eot), median: median(eot), mean: Number(mean(eot).toFixed(1)), max: Math.max(...eot), samples: eot } : null,
    eagerEndOfTurnToEndOfTurnMs: eagerLead.length ? { min: Math.min(...eagerLead), median: median(eagerLead), mean: Number(mean(eagerLead).toFixed(1)), max: Math.max(...eagerLead), samples: eagerLead } : null,
    falseResumeCount: runs.reduce((sum, run) => sum + (run.falseResumeCount ?? 0), 0),
  };
}

function renderMarkdown(results, options) {
  const rows = results
    .slice()
    .sort((a, b) => (a.speechEndToEndOfTurnMs?.median ?? Number.POSITIVE_INFINITY) - (b.speechEndToEndOfTurnMs?.median ?? Number.POSITIVE_INFINITY))
    .map((result) => `| ${result.provider} | ${result.completionCount}/${result.sampleCount} | ${result.speechEndToEndOfTurnMs?.min ?? 'n/a'} | ${result.speechEndToEndOfTurnMs?.median ?? 'n/a'} | ${result.speechEndToEndOfTurnMs?.mean ?? 'n/a'} | ${result.speechEndToEndOfTurnMs?.max ?? 'n/a'} | ${result.eagerEndOfTurnToEndOfTurnMs?.median ?? 'n/a'} | ${result.falseResumeCount} |`)
    .join('\n');

  return `# Turn Detection Benchmark Results\n\n` +
    `Probe URL: \`${options.probeUrl}\`\n\n` +
    `Manifest clips: \`${options.limit}\` max, \`${options.sampleCount}\` measured rounds after one warm-up per provider.\n\n` +
    `| Provider | Completed | EOT Min (ms) | EOT Median (ms) | EOT Mean (ms) | EOT Max (ms) | Eager->EOT Median (ms) | False Resumes |\n` +
    `|---|---:|---:|---:|---:|---:|---:|---:|\n` +
    `${rows}\n`;
}

const options = parseArgs(process.argv.slice(2));
const manifest = selectTurnEntries(readJsonLines(await readFile(MANIFEST_PATH, 'utf8')), options.limit);
const plan = ['deepgram-direct', 'workers-ai-flux'];

if (options.dryRun) {
  console.log(JSON.stringify({ kind: 'turn-bench-dry-run', probeUrl: options.probeUrl, outputDir: options.outputDir, sampleCount: options.sampleCount, clips: manifest.map(({ id, audioPath, speechEndMs }) => ({ id, audioPath, speechEndMs })), plan }, null, 2));
  process.exit(0);
}

const clips = [];
for (const entry of manifest) {
  const loaded = await loadClipBase64(entry.audioPath);
  clips.push({ ...entry, ...loaded });
}

const runMap = new Map(plan.map((provider) => [provider, []]));
for (const provider of plan) {
  const clip = clips[0];
  await invokeProbe(options.probeUrl, { provider, audioBase64: clip.audioBase64, sampleRate: clip.sampleRate, speechEndMs: clip.estimatedSpeechEndMs, eotThreshold: 0.5, eagerEotThreshold: 0.4, eotTimeoutMs: 700 });
}
for (let round = 0; round < options.sampleCount; round += 1) {
  for (const clip of clips) {
    for (const provider of plan) {
      const result = await invokeProbe(options.probeUrl, { provider, audioBase64: clip.audioBase64, sampleRate: clip.sampleRate, speechEndMs: clip.estimatedSpeechEndMs, eotThreshold: 0.5, eagerEotThreshold: 0.4, eotTimeoutMs: 700 });
      runMap.get(provider).push({
        clipId: clip.id,
        manifestSpeechEndMs: clip.speechEndMs,
        estimatedSpeechEndMs: clip.estimatedSpeechEndMs,
        ...result,
      });
    }
  }
}

const results = plan.map((provider) => ({ provider, sampleCount: runMap.get(provider).length, ...summariseRuns(runMap.get(provider)), runs: runMap.get(provider) }));

await mkdir(options.outputDir, { recursive: true });
await writeFile(resolve(options.outputDir, `${OUTPUT_STEM}.json`), JSON.stringify(results, null, 2));
await writeFile(resolve(options.outputDir, `${OUTPUT_STEM}.md`), renderMarkdown(results, options));
console.log(JSON.stringify(results, null, 2));
