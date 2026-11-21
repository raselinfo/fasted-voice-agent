import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const DEFAULT_PROBE_URL = process.env.PROVIDER_BENCH_URL ?? 'http://127.0.0.1:8791';
const DEFAULT_OUTPUT_DIR = process.env.PROVIDER_BENCH_OUTPUT_DIR ?? '.planning/quick/260405-x9v-benchmark-all-provider-swap-options-for-';
const DEFAULT_SAMPLE_COUNT = 3;
const DEFAULT_LIMIT = 6;
const MANIFEST_PATH = resolve(ROOT, 'scripts/provider-bench/corpus-manifest.jsonl');
const OUTPUT_STEM = '260405-x9v-llm-results';

const SUITES = [
  { provider: 'groq', models: ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'] },
  { provider: 'workers-ai', models: ['@cf/ibm-granite/granite-4.0-h-micro', '@cf/openai/gpt-oss-20b'] },
];

function parseArgs(argv) {
  const options = { dryRun: false, limit: DEFAULT_LIMIT, sampleCount: DEFAULT_SAMPLE_COUNT, probeUrl: DEFAULT_PROBE_URL, outputDir: resolve(ROOT, DEFAULT_OUTPUT_DIR) };
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

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function invokeProbe(probeUrl, payload) {
  const response = await fetch(`${probeUrl}/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

function renderMarkdown(results, options) {
  const rows = results
    .slice()
    .sort((a, b) => a.ttft.median - b.ttft.median)
    .map((result) => `| ${result.provider} | ${result.model} | ${result.ttft.min} | ${result.ttft.median} | ${result.ttft.mean} | ${result.ttft.max} | ${result.total.median} |`)
    .join('\n');

  return `# LLM Benchmark Results\n\n` +
    `Probe URL: \`${options.probeUrl}\`\n\n` +
    `Manifest texts: \`${options.limit}\` max, \`${options.sampleCount}\` measured rounds after one warm-up per model.\n\n` +
    `| Provider | Model | TTFT Min (ms) | TTFT Median (ms) | TTFT Mean (ms) | TTFT Max (ms) | Total Median (ms) |\n` +
    `|---|---|---:|---:|---:|---:|---:|\n` +
    `${rows}\n`;
}

const options = parseArgs(process.argv.slice(2));
const manifest = readJsonLines(await readFile(MANIFEST_PATH, 'utf8')).slice(0, options.limit);
const prompts = manifest.map((entry) => entry.text);
const plan = SUITES.flatMap((suite) => suite.models.map((model) => ({ provider: suite.provider, model })));

if (options.dryRun) {
  console.log(JSON.stringify({ kind: 'llm-bench-dry-run', probeUrl: options.probeUrl, outputDir: options.outputDir, sampleCount: options.sampleCount, prompts, plan }, null, 2));
  process.exit(0);
}

const runMap = new Map(plan.map((item) => [`${item.provider}:${item.model}`, []]));
for (const item of plan) {
  await invokeProbe(options.probeUrl, { provider: item.provider, model: item.model, prompt: prompts[0], maxTokens: 1 });
}
for (let round = 0; round < options.sampleCount; round += 1) {
  for (const prompt of prompts) {
    for (const item of plan) {
      const result = await invokeProbe(options.probeUrl, { provider: item.provider, model: item.model, prompt, maxTokens: 1 });
      runMap.get(`${item.provider}:${item.model}`).push(result);
    }
  }
}

const results = plan.map((item) => {
  const runs = runMap.get(`${item.provider}:${item.model}`);
  const ttfts = runs.map((run) => run.ttftMs);
  const totals = runs.map((run) => run.totalMs);
  return {
    provider: item.provider,
    model: item.model,
    sampleCount: runs.length,
    ttft: { min: Math.min(...ttfts), median: median(ttfts), mean: Number(mean(ttfts).toFixed(1)), max: Math.max(...ttfts), samples: ttfts },
    total: { min: Math.min(...totals), median: median(totals), mean: Number(mean(totals).toFixed(1)), max: Math.max(...totals), samples: totals },
    runs,
  };
});

await mkdir(options.outputDir, { recursive: true });
await writeFile(resolve(options.outputDir, `${OUTPUT_STEM}.json`), JSON.stringify(results, null, 2));
await writeFile(resolve(options.outputDir, `${OUTPUT_STEM}.md`), renderMarkdown(results, options));
console.log(JSON.stringify(results, null, 2));
