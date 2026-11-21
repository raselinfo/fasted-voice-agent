# Provider Bench

Standalone benchmark harness for provider-swap experiments across the voice stack.

## What it covers

- `run-llm.mjs`: LLM first-text latency using the same Worker-side pattern as the existing TTFT probe.
- `run-tts.mjs`: TTS first-audio, speech-RMS, and loudness baseline measurement.
- `run-turn.mjs`: realtime turn-detection latency from prerecorded conversation clips.

## Corpus

This suite uses a small manifest-driven corpus of real meeting audio from the AMI Meeting Corpus (`CC BY 4.0`).
Raw audio is prepared locally into `.cache/provider-bench/` and is not intended to be committed.

Prepare a small local subset:

```bash
node scripts/provider-bench/prepare-corpus.mjs --limit 4
```

Dry-run the preparation logic:

```bash
node scripts/provider-bench/prepare-corpus.mjs --dry-run --limit 2
```

## Probe worker

Start the dedicated benchmark worker in remote dev:

```bash
npx wrangler dev --remote --config scripts/provider-bench/wrangler.jsonc --port 8791
```

The worker exposes:

- `POST /llm`
- `POST /tts`
- `POST /turn`

For TTS loudness work, `POST /tts` can also return the captured mono PCM16 audio payload to the local runner so Aura (via Workers AI inside the Worker) and external providers are measured through one analysis path.

## Runners

Dry-run all families:

```bash
PROVIDER_BENCH_URL=http://127.0.0.1:8791 node scripts/provider-bench/run-llm.mjs --dry-run --limit 2
PROVIDER_BENCH_URL=http://127.0.0.1:8791 node scripts/provider-bench/run-tts.mjs --dry-run --limit 2
PROVIDER_BENCH_URL=http://127.0.0.1:8791 node scripts/provider-bench/run-turn.mjs --dry-run --limit 2
```

Actual low-cost first pass:

```bash
PROVIDER_BENCH_URL=http://127.0.0.1:8791 node scripts/provider-bench/run-llm.mjs --sample-count 3 --limit 6
PROVIDER_BENCH_URL=http://127.0.0.1:8791 node scripts/provider-bench/run-tts.mjs --sample-count 3
PROVIDER_BENCH_URL=http://127.0.0.1:8791 node scripts/provider-bench/run-turn.mjs --sample-count 2 --limit 4
```

The loudness runner uses the dedicated prompt set in `scripts/provider-bench/tts-prompts.json`, writes per-run outputs under `.planning/...`, and updates the checked-in baseline artifacts:

- `scripts/provider-bench/tts-loudness-baseline.json`
- `scripts/provider-bench/tts-loudness-baseline.md`

Those baseline files start as placeholders and are overwritten by the first successful live run.

## Fairness notes

- LLM uses first non-empty streamed text delta.
- TTS uses first audio bytes and total synthesis completion, then computes speech-window RMS plus a secondary LUFS-style loudness metric from the captured PCM.
- Turn replay uses `speechEndToEndOfTurnMs` and optional eager metrics.
- The TTS loudness pass is full-utterance focused. It is intended to compare provider/model baselines before any runtime gain normalization or trim-threshold changes.
