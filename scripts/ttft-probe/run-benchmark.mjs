import { mkdir, writeFile } from "node:fs/promises";

const PROBE_URL = process.env.TTFT_PROBE_URL ?? "http://127.0.0.1:8790";
const QUICK_DIR = process.env.TTFT_OUTPUT_DIR ?? ".planning/quick/260405-wrj-compare-ttft-across-groq-and-workers-ai-";
const SAMPLE_COUNT = Number(process.env.TTFT_SAMPLE_COUNT ?? 3);
const MAX_TOKENS = Number(process.env.TTFT_MAX_TOKENS ?? 1);

const PROMPTS = [
  "Reply with exactly one token: 2+2",
  "Reply with exactly one token: 10-3",
  "Reply with exactly one token: first prime after 10",
];

const SUITES = [
  {
    provider: "groq",
    models: [
      "llama-3.1-8b-instant",
      "openai/gpt-oss-20b",
      "qwen/qwen3-32b",
      "llama-3.3-70b-versatile",
    ],
  },
  {
    provider: "workers-ai",
    models: [
      "@cf/ibm-granite/granite-4.0-h-micro",
      "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
      "@cf/openai/gpt-oss-20b",
      "@cf/zai-org/glm-4.7-flash",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    ],
  },
];

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function invokeProbe({ provider, model, prompt, maxTokens }) {
  const response = await fetch(PROBE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model, prompt, maxTokens }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${provider} ${model}: ${payload.error ?? response.statusText}`);
  }

  if (typeof payload.ttftMs !== "number") {
    throw new Error(`${provider} ${model}: missing ttftMs`);
  }

  return payload;
}

async function benchmarkModel(provider, model) {
  const warmupPrompt = PROMPTS[0];
  await invokeProbe({ provider, model, prompt: warmupPrompt, maxTokens: MAX_TOKENS });

  const runs = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const prompt = PROMPTS[index % PROMPTS.length];
    const result = await invokeProbe({ provider, model, prompt, maxTokens: MAX_TOKENS });
    runs.push({
      prompt,
      ttftMs: result.ttftMs,
      totalMs: result.totalMs,
      totalBytes: result.totalBytes,
      preview: result.preview,
    });
  }

  const ttfts = runs.map((run) => run.ttftMs);
  const totals = runs.map((run) => run.totalMs);

  return {
    provider,
    model,
    sampleCount: runs.length,
    ttft: {
      min: Math.min(...ttfts),
      median: median(ttfts),
      mean: Number(mean(ttfts).toFixed(1)),
      max: Math.max(...ttfts),
      samples: ttfts,
    },
    total: {
      min: Math.min(...totals),
      median: median(totals),
      mean: Number(mean(totals).toFixed(1)),
      max: Math.max(...totals),
      samples: totals,
    },
    runs,
  };
}

function renderMarkdown(results) {
  const rows = results
    .slice()
    .sort((a, b) => a.ttft.median - b.ttft.median)
    .map(
      (result) =>
        `| ${result.provider} | ${result.model} | ${result.ttft.min} | ${result.ttft.median} | ${result.ttft.mean} | ${result.ttft.max} | ${result.total.median} |`,
    );

  return `# TTFT Benchmark Results\n\n` +
    `Probe URL: \`${PROBE_URL}\`\n\n` +
    `Prompt style: one-token answers, \`max_tokens=${MAX_TOKENS}\`, \`${SAMPLE_COUNT}\` measured runs after one warm-up per model.\n\n` +
    `| Provider | Model | TTFT Min (ms) | TTFT Median (ms) | TTFT Mean (ms) | TTFT Max (ms) | Total Median (ms) |\n` +
    `|---|---|---:|---:|---:|---:|---:|\n` +
    `${rows.join("\n")}\n`;
}

const results = [];
for (const suite of SUITES) {
  for (const model of suite.models) {
    console.error(`Benchmarking ${suite.provider} ${model}...`);
    results.push(await benchmarkModel(suite.provider, model));
  }
}

await mkdir(QUICK_DIR, { recursive: true });
await writeFile(`${QUICK_DIR}/260405-wrj-results.json`, JSON.stringify(results, null, 2));
await writeFile(`${QUICK_DIR}/260405-wrj-results.md`, renderMarkdown(results));

console.log(JSON.stringify(results, null, 2));
