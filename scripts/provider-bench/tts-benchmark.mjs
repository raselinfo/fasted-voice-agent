import { readFile } from "node:fs/promises";

export const DEFAULT_TTS_PROMPT_SET_PATH = "scripts/provider-bench/tts-prompts.json";
export const DEFAULT_TTS_BASELINE_JSON_PATH = "scripts/provider-bench/tts-loudness-baseline.json";
export const DEFAULT_TTS_BASELINE_MD_PATH = "scripts/provider-bench/tts-loudness-baseline.md";

export const DEFAULT_TTS_PLAN = [
  { provider: "workers-ai", model: "@cf/deepgram/aura-2-en", label: "Aura 2" },
  { provider: "elevenlabs", model: "eleven_flash_v2_5", label: "ElevenLabs Flash v2.5" },
  { provider: "together-orpheus", model: "canopylabs/orpheus-3b-0.1-ft", voice: "leo", label: "Together Orpheus" },
];

export const ORPHEUS_HEAD_TO_HEAD_TTS_PLAN = [
  { provider: "together-orpheus", model: "canopylabs/orpheus-3b-0.1-ft", voice: "leo", label: "Together Orpheus" },
  { provider: "groq-orpheus", model: "canopylabs/orpheus-v1-english", voice: "troy", label: "Groq Orpheus" },
];

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summariseNumericField(runs, field, digits = 1) {
  const values = runs.map((run) => run[field]).filter((value) => typeof value === "number");
  if (values.length === 0) {
    return null;
  }

  return {
    min: Number(Math.min(...values).toFixed(digits)),
    median: Number(median(values).toFixed(digits)),
    mean: Number(mean(values).toFixed(digits)),
    max: Number(Math.max(...values).toFixed(digits)),
    samples: values,
  };
}

function formatCell(value, digits = 1) {
  return typeof value === "number" ? value.toFixed(digits) : "n/a";
}

export async function loadTtsPromptSet(promptSetPath) {
  const raw = await readFile(promptSetPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("TTS prompt set must be a non-empty JSON array.");
  }

  return parsed.map((entry, index) => {
    const id = typeof entry?.id === "string" && entry.id.trim() ? entry.id.trim() : `prompt_${index + 1}`;
    const label = typeof entry?.label === "string" && entry.label.trim() ? entry.label.trim() : id;
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    if (!text) {
      throw new Error(`Prompt ${id} is missing text.`);
    }
    return { id, label, text };
  });
}

export function createTtsPlan({ orpheusHeadToHead = false } = {}) {
  return orpheusHeadToHead ? ORPHEUS_HEAD_TO_HEAD_TTS_PLAN : DEFAULT_TTS_PLAN;
}

export function summariseTtsRuns(runs) {
  return {
    ttfa: summariseNumericField(runs, "ttfaMs", 1),
    ttsDone: summariseNumericField(runs, "ttsDoneMs", 1),
    realTimeFactor: summariseNumericField(runs, "realTimeFactor", 3),
    leadingSilenceMs: summariseNumericField(runs, "leadingSilenceMs", 1),
    speechDurationMs: summariseNumericField(runs, "speechDurationMs", 1),
    speechRmsDbfs: summariseNumericField(runs, "speechRmsDbfs", 2),
    integratedRmsDbfs: summariseNumericField(runs, "integratedRmsDbfs", 2),
    integratedLoudnessLufs: summariseNumericField(runs, "integratedLoudnessLufs", 2),
    loudnessRangeLu: summariseNumericField(runs, "loudnessRangeLu", 2),
    peakDbfs: summariseNumericField(runs, "peakDbfs", 2),
    truePeakDbfs: summariseNumericField(runs, "truePeakDbfs", 2),
  };
}

export function deriveSuggestedGainDb(results) {
  const targetCandidates = results
    .map((result) => result.speechRmsDbfs?.median)
    .filter((value) => typeof value === "number");

  if (targetCandidates.length === 0) {
    return {
      targetSpeechRmsDbfs: null,
      suggestedGainByKey: {},
    };
  }

  const targetSpeechRmsDbfs = Number(median(targetCandidates).toFixed(2));
  const suggestedGainByKey = {};

  for (const result of results) {
    const speechMedian = result.speechRmsDbfs?.median;
    suggestedGainByKey[`${result.provider}:${result.model}`] =
      typeof speechMedian === "number"
        ? Number((targetSpeechRmsDbfs - speechMedian).toFixed(2))
        : null;
  }

  return {
    targetSpeechRmsDbfs,
    suggestedGainByKey,
  };
}

export function renderTtsMarkdown(results, options) {
  const rows = results
    .slice()
    .sort((left, right) => {
      const leftValue = left.speechRmsDbfs?.median ?? Number.POSITIVE_INFINITY;
      const rightValue = right.speechRmsDbfs?.median ?? Number.POSITIVE_INFINITY;
      return leftValue - rightValue;
    })
    .map((result) =>
      `| ${result.provider} | ${result.model} | ${formatCell(result.speechRmsDbfs?.median, 2)} | ${formatCell(result.integratedLoudnessLufs?.median, 2)} | ${formatCell(result.leadingSilenceMs?.median, 1)} | ${formatCell(result.truePeakDbfs?.median, 2)} | ${formatCell(result.suggestedGainDbToMedianSpeechRms, 2)} | ${formatCell(result.ttfa?.median, 1)} |`,
    )
    .join("\n");

  return `# TTS Loudness Baseline\n\n` +
    `Probe URL: \`${options.probeUrl}\`\n\n` +
    `Prompt set: \`${options.promptSetPath}\`\n\n` +
    `Measured rounds: \`${options.sampleCount}\` after one warm-up per provider/model.\n\n` +
    `Target median speech RMS: \`${typeof options.targetSpeechRmsDbfs === "number" ? options.targetSpeechRmsDbfs.toFixed(2) : "n/a"} dBFS\`\n\n` +
    `| Provider | Model | Speech RMS Median (dBFS) | Loudness Median (LUFS) | Leading Silence Median (ms) | True Peak Median (dBFS) | Suggested Gain (dB) | TTFA Median (ms) |\n` +
    `|---|---|---:|---:|---:|---:|---:|---:|\n` +
    `${rows}\n`;
}
