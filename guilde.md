# Iris Voice Agent — Codebase Guide

Practical guide for this repo. Assumes you already know Cloudflare Workers + Durable Objects; no platform basics here.

Live demo: [aa0.dev/voice-agent](https://aa0.dev/voice-agent). Target: ~150ms end-of-turn → first audible audio (TTFA).

---

## 1. What this system is

A realtime voice agent: browser mic audio → server pipeline (turn detection → LLM → TTS) → PCM audio back to browser.

Pipeline is **fully streaming and overlapping** — STT, LLM, and TTS run concurrently:

```
Browser (mic, AudioWorklet)
   │  raw PCM16 WebSocket frames (no base64/JSON wrapping)
   ▼
Worker (src/worker/index.ts)  ── static assets, health, WS upgrade
   │  stub.fetch()
   ▼
SessionDO (src/durable/session-do.ts)          ← one DO instance per session, owns the WS
   │
   ├─ Turn Detector   Deepgram Flux v2 (direct WS)  OR  Workers AI @cf/deepgram/flux
   ├─ Text Generator  Groq (SSE stream, llama-4-scout-17b, max 128 tokens)
   ├─ TTS             ElevenLabs multi-context WS / Together Orpheus SSE / Workers AI Aura 2
   └─ Background lane Groq tool planner (gpt-oss-20b native tool calls) → in-memory tools
```

Two latency tricks to know upfront:

1. **Speculative generation**: Deepgram Flux emits `EagerEndOfTurn` at ~0.3 end-of-turn confidence. The DO starts LLM+TTS immediately ("speculative turn"). Audio is buffered, not sent. When the final `EndOfTurn` arrives:
   - transcript matches → **commit** → flush buffered audio to client (feels instant)
   - transcript differs / `TurnResumed` → **abort** everything and restart with the final transcript
2. **Clause-level TTS streaming**: LLM deltas are split into speech-ready clauses (`splitReadySpeechClauses` — punctuation boundaries or 80-char fallback) and pushed into the TTS stream while the LLM is still generating. TTS output's leading silence is trimmed (`findLeadingSpeechOffset`) so no dead air is sent.

---

## 2. Root config files

| File | What it does |
|---|---|
| `package.json` | pnpm 10, ESM. Scripts: `dev` / `dev:local` (wrangler), `deploy`, `test` (vitest), `typecheck`. Deps: `@deepgram/sdk` (mostly unused directly — adapters hand-roll fetch WS), `elevenlabs`, `groq-sdk` (adapters hand-roll too; deps kept for types/tests), `jsonrepair` (salvage broken LLM JSON), `zod` (protocol validation). |
| `wrangler.jsonc` | `main: src/worker/index.ts`. `ai` binding `AI`. `vars`: `APP_BASE_PATH=/voice-agent`, `TURN_DETECTOR_PROVIDER=workers-ai-flux`, `TTS_PROVIDER=together-orpheus`, PostHog host/transcript flags. DO binding `SESSION_DO` → class `SessionDO`, SQLite-backed (`new_sqlite_classes`). Static assets dir `src/web` with binding `ASSETS` and `run_worker_first: true` (every request hits the worker first — needed for base-path rewriting). Routes on `aa0.dev/voice-agent`. Required secrets: `GROQ_API_KEYS`, `TOGETHER_API_KEY`, `ELEVENLABS_API_KEY`. Observability logs on. |
| `tsconfig.json` | ES2022, bundler resolution, strict, workers-types + node types. `noEmit` — wrangler bundles. |
| `vitest.config.ts` | **Two test pools.** Files listed in `plainNodeTestFiles` (UI specs, pure-logic specs) run in plain node; everything else runs in `@cloudflare/vitest-pool-workers` with `wrangler.jsonc` — i.e., real DO runtime for session tests. Passing explicit `.spec.ts` args switches pool per-arg. |
| `.gitignore` | `.dev.vars` (local secrets), `.wrangler/`, `.cache/` (provider-bench audio corpus), planning scratch. |

### Secrets / env

- `GROQ_API_KEYS` — comma/newline-separated **pool**; falls back to single `GROQ_API_KEY`.
- `DEEPGRAM_API_KEY` / `DEEPGRAM_KEY` — only needed when `TURN_DETECTOR_PROVIDER=deepgram-direct`.
- `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` — elevenlabs TTS only.
- `TOGETHER_API_KEY` (+ optional `TOGETHER_TTS_VOICE`) — together-orpheus TTS only.
- `POSTHOG_PROJECT_API_KEY` (+ host/replay/transcript vars) — analytics, optional.
- `.dev.vars.example` → `.dev.vars` for local dev.

Provider selection: `TURN_DETECTOR_PROVIDER` = `deepgram-direct` (default) | `workers-ai-flux`. `TTS_PROVIDER` = `elevenlabs` (default) | `together-orpheus` | `workers-ai-aura`. The browser can also override TTS per session (`ttsConfig` in `session.start`).

---

## 3. `src/worker/index.ts` — Worker entrypoint

Exports `Env` (bindings + secrets), the default fetch handler, and re-exports `SessionDO` (required for the DO migration to find the class).

Routes (all under optional `APP_BASE_PATH`, default `/voice-agent`):

1. `GET <base>/api/health` → `buildHealthResponse`. Checks which secrets/bindings are missing **given the configured providers** (e.g., together-orpheus only needs `TOGETHER_API_KEY`; `workers-ai-flux` turn detector needs the `AI` binding). Returns 200 `{ok:true}` or 503 with `missingSecrets`/`missingBindings`. This is the deploy-readiness probe (tested in `tests/deployment-reliability/health.spec.ts`).
2. `GET <base>/api/session` with `Upgrade: websocket` → resolves `sessionId` from query (or generates a UUID), gets the DO stub via `env.SESSION_DO.getByName(sessionId)`, and **forwards the same request** to the DO. The DO actually performs the WebSocketPair upgrade. Note the forward rewrites pathname to a fixed `/api/session` — inside the DO base path doesn't matter.
3. Everything else → `serveAsset`: strips base path, `env.ASSETS.fetch`, then `rewriteHtmlForBasePath`:
   - `HTMLRewriter` rewrites `href`/`src` starting with `/` to be base-path-prefixed (`PrefixAbsoluteAssetUrl`) — the frontend is served from `/voice-agent/...` in prod.
   - Injects into `<head>`: `window.__APP_BASE_PATH__` and, if PostHog is configured, the inline bootstrap script from `buildPostHogBrowserBootstrapScript`.

There is **no other server logic here** — the entire voice session lives in the DO.

---

## 4. `src/protocol/messages.ts` — WS protocol

Audio is **raw binary frames**; all control messages are JSON. Zod schemas mirror every TS type; `serverMessageSchema`/`clientMessageSchema` are discriminated unions on `type`. The DO validates *outgoing* messages with the server schema before send (a bad payload would throw — caught silently), and incoming with the client schema (bad → `session.error INVALID_MESSAGE`).

Client → server:
- `session.start` — sessionId, `sampleRate` (browser AudioContext rate), `audioFormat` (must be `pcm16`/1ch), optional `scenario`, `ttsConfig {provider, model, voice}`, `demoOverrides {systemPrompt, disabledTools}`, optional analytics ids.
- `client.interrupt` — barge-in hint from browser VAD.
- `turn.assistant.playback.started` / `.ended` / `turn.assistant.audio.start.received` — client acks carrying `assistantTurnId` + `clientTsMs`; these close the latency loop (marks `playbackStart`/`playbackEnd`).
- `session.stop`.

Server → client:
- `session.ready`, `session.state` (state machine value), `session.error {code,message}`, `session.closed {reason}`.
- `turn.user.final {turnId, text}`, `turn.assistant.final {assistantTurnId, text}`.
- `turn.assistant.audio.start {assistantTurnId, sampleRate, encoding, channels}` then **binary PCM frames**, then `turn.assistant.audio.end {isFinal}`.
- `turn.interrupted {assistantTurnId, reason: "start_of_turn"|"client_hint"}`.
- `background.turn.update {turnId, status, summary, actions[]}` — background tool lane progress.
- `turn.trace {assistantTurnId, marksFromEndOfTurnMs}` — latency marks relative to end-of-turn; drives the client Gantt chart.

Turn id semantics: user turns are 1,2,3…; assistant turns share the counter; **followup assistant turns start at 1,000,000** to avoid collision with playback ids.

---

## 5. `src/durable/` — session actor

### `session-state.ts`
Trivial but referenced everywhere: `SessionState = idle | requesting_mic | connecting | listening | thinking | speaking | interrupted | error` + `SESSION_STATE_SEQUENCE` (used by zod enum for `session.state`).

### `session-do.ts` — the core file (~2500 lines)

The DO keeps **all session state in memory** (no DO storage calls — a call is ephemeral; hibernation is not used, `acceptWebSocket` + in-memory fields). One active socket at a time: a new WS on the same DO id replaces the old one (`replaced_connection`).

Lifecycle methods (DO WebSocket hibernation API):

- `fetch()` — validates upgrade, creates `WebSocketPair`, replaces stale socket, `acceptWebSocket`, sends `session.ready`, state → `connecting`.
- `webSocketMessage()` — binary frame → `forwardAudioChunk` (requires prior `session.start`, else `AUDIO_NOT_NEGOTIATED`); text → zod-parse → switch. `session.start` resets call state, stores sampleRate/scenario/tts overrides, fires three parallel warmups (`prepareSessionForListening` → turn-detector connect, `prewarmSpeechSynthesizer`, `prewarmTextGenerator` — a throwaway Groq stream that warms the provider's prompt cache, first 1 chunk then abort).
- `webSocketClose` / `webSocketError` → notify + `clearActiveConnection` (full teardown: abort active work, close turn detector, dispose runtime, reset scenario/TTS overrides, analytics `call_ended`).

Turn detector wiring (`ensureTurnDetectorSession`): lazily creates a `TurnDetectorSession` from the provider runtime with 4 callbacks → `handleStartOfTurn`, `handleEagerEndOfTurn`, `handleEndOfTurn`, `handleTurnResumed`. Single in-flight `connect()` promise shared across audio chunks.

**Turn handling — the important part:**

- `handleStartOfTurn` — user began speaking. If an uncommitted turn is in flight → cancel (barge-in on server side).
- `handleEagerEndOfTurn(transcript)` — fires at ~0.3 confidence → `startAssistantTurn(speculative=true)`. If a speculative turn already runs with the same transcript, ignore; with a different transcript, keep the old one until final EOT decides.
- `handleTurnResumed` — Deepgram decided the turn isn't over after all → cancel speculative turn.
- `handleEndOfTurn(finalTranscript)` — the real EOT. If a speculative turn exists and transcripts match → `commitAssistantTurn` (zero added latency). If mismatch → cancel + start fresh (`speculative=false`, commits immediately).

**`startAssistantTurn`** builds `ActiveProviderWork` (abort controllers for LLM/TTS, `TurnLatencyTracker`, buffered audio, committed/completed flags) and runs `runAssistantPipeline`:

1. `streamText(promptHistory)` — Groq SSE. `promptHistory` = system prompt + conversation history (+ uncommitted transcript) + **hidden system notes** from background tool results (`buildHiddenResultNotes`, e.g. `[turn 3 result] completed: add_menu_item=ok {...}` truncated to 220 chars).
2. Each delta → `splitReadySpeechClauses` → each ready clause → `sendTextToTts` → lazy `ensureTtsStream` (connect on first text) → `ttsStream.sendText`.
3. TTS `onAudioChunk`: marks `firstAudioGenerated`; if turn **not committed** → push to `bufferedAudioChunks` (speculative hold); if committed → `emitBufferedAssistantAudio` immediately.
4. LLM done → `finalAssistantText` → `maybeEmitAssistantFinal` (emits `turn.assistant.final`, pushes to history, enqueues background pass) → flush TTS → `finishCommittedAssistantTurn` (sends `audio.end`, logs trace, state → listening).
5. Rate-limit handling: `GroqRateLimitError` before first token → `advancePinnedGroqApiKey` (rotate to next key in pool, rebuild runtime) → rerun the whole pipeline once.
6. Abort errors (barge-in/speculation-cancel) are swallowed; everything else → `handlePipelineError` (state → error, `session.error ASSISTANT_PIPELINE_FAILED`).

**`commitAssistantTurn`**: marks `endOfTurn`, emits `turn.user.final` + pushes user msg to history, flushes any buffered audio (state → `speaking` on first chunk), and completes if the pipeline already finished.

**Audio emit order matters**: `turn.assistant.audio.start` (JSON) → binary chunks → `turn.assistant.audio.end`. Client keys its playback queue on these.

**Interruption (`cancelActiveAssistantTurn`)**: aborts LLM/TTS via the abort controllers + closes TTS stream, adds turn id to `invalidatedAssistantTurnIds` (so late async callbacks from that turn are dropped by `isAssistantTurnCurrent`), emits `turn.interrupted`, state → `listening`.

**Client acks**: `playback.started` marks `playbackStart` and logs the full latency + trace; `playback.ended` marks `playbackEnd` (only used if the trace was pending). Both reset `assistantPlaybackActive`, which gates the idle timer.

**Idle hangup**: 10s in `listening` with no active user turn/playback → `session.closed` + close.

**Background tool lane** (flag `ENABLE_BACKGROUND_TOOL_LANE=true`, followups disabled):

- After each assistant final → `enqueueBackgroundPass` onto a serialized `backgroundQueue` promise chain.
- `runBackgroundPass`: appends user/assistant turns to a **separate** `backgroundHistory` → builds planner messages → planning mode is `groq_native_tool_calls` when textGenerator is groq (else structured JSON fallback):
  - Native: `generateBackgroundToolPlanWithNativeCalls` — non-streaming chat with a single `submit_actions` tool whose JSON schema is built from the live tool names (`buildPlannerTools`/`buildSubmitActionsParameters` per-tool schemas). Handles Groq 400 `tool_use_failed` by salvaging `error.failed_generation` (with `jsonrepair`) or retrying once with a corrective user message.
  - Structured: plain text completion parsed by `parseToolPlan` (zod strict `{actions:[{tool,args}]}`).
- Executes via `executeAllowlistedActions` against `getBackgroundToolRegistry()` — scenario-specific **in-memory mock backends**:
  - drive-thru: cart in `backgroundCartItems` with price catalog + aliases; `add/remove_menu_item`, `get_order_total`, `submit_order` (random 4-digit order id, clears cart).
  - restaurant-booking: `check_availability`, `create_reservation`, `update_reservation`, `cancel_reservation` (fabricated slots/codes).
  - customer-support: `lookup_order` (fixtures `1001`/`2002`), `start_return`, `update_shipping_address`, `escalate_to_human`.
- Results → `updateBackgroundTurnResult` → `background.turn.update` to client (drives the "Background Agent" panel) + stored in `backgroundTurnResults`, which become the hidden notes in the next main-agent prompt (see `buildPromptHistory`). `demoDisabledTools` filters the registry.
- Followup agent (`BACKGROUND_FOLLOWUP_SYSTEM_PROMPT`, "[pass] or short update") exists but is disabled (`ENABLE_BACKGROUND_FOLLOWUPS=false`); `deferredFollowupIngestion`/`nextFollowupAssistantTurnId` support it.

**Misc but load-bearing:**

- `ensureRuntimeState()` — defensive re-init of every field; protects against DO instance reuse across calls where constructor state may be stale.
- Groq key pool state: `groqRankedApiKeys` ranked once per session (FNV-1a hash of `sessionId:keyLabel` → deterministic, spreads load across keys/sessions), pinned index advanced only on 429; `providerRuntime` is rebuilt on repin or TTS config change.
- `syncIdleHangupTimer` / `clearIdleHangupTimer` — timer re-armed on every state transition.
- Operational logging: everything goes through `logOperationalEvent` (`console.log(JSON.stringify({event, ts, ...}))`) → `wrangler tail` / observability logs. `turn.trace` / `turn.latency` events carry the full latency breakdown.

### `background-tool-lane.ts`
Pure helpers used by the DO: zod schemas for tool plan, `parseToolPlan`, `executeAllowlistedActions` (per-action try/catch, unknown tool = failure record), `normalizeFollowupCandidate` (240-char cap, `[pass]` sentinel).

---

## 6. `src/providers/` — contracts and runtime assembly

### `contracts.ts`
The seam of the whole system — everything provider-specific hides behind these:
- `TurnDetectorSession {connect, sendAudioChunk, close}` + factory; callbacks passed via options (`onStartOfTurn/onEagerEndOfTurn/onEndOfTurn/onTurnResumed/onError`).
- `TextGenerator.streamText(messages, signal, onUsage?) → AsyncGenerator<string>`.
- `SpeechSynthesizerStream {connect, sendText, flush, close(aborted)}` + factory with `sampleRate` and optional `prewarm`.
- `ProviderRuntime {labels, turnDetector, textGenerator, speechSynthesizer, dispose?}`.
- `resolveTurnDetectorProvider` / `resolveTtsProvider` — strict allowlists, unknown values fall back to defaults.

### `default-runtime.ts`
Factory wiring env → concrete adapters. Notable details:
- Flux thresholds hardcoded at session creation: `eotThreshold: 0.7`, `eagerEotThreshold: 0.3`, `eotTimeoutMs: 1100` — the speculation knob lives here.
- `TTS_GAIN_DB_BY_PROVIDER_MODEL` — per provider:model loudness normalization (Aura +1.5dB, Orpheus −3.03dB, ElevenLabs 0) applied server-side by `Pcm16GainProcessor`.
- Sample rates: ElevenLabs/Aura 16kHz, Orpheus 24kHz (`audio.start` tells the client, which resamples).
- ElevenLabs: one `ElevenLabsMultiContextSocket` per runtime, shared by all turn streams (contexts multiplexed over one WS); `dispose()` force-closes it.

### `groq-key-pool.ts`
`parseGroqApiKeys` (split on comma/newline, `pool-N` labels, fallback to `GROQ_API_KEY` as `primary`) + `rankGroqApiKeys` (FNV-1a 64-bit of `sessionId:label`, deterministic per session) + `selectGroqApiKey`. Purpose: spread sessions across key pool without coordination; repinning handles mid-session 429s.

---

## 7. `src/adapters/` — provider integrations

### `deepgram-flux.ts` — Deepgram Flux v2 bridge
Hand-rolled WS upgrade to `https://api.deepgram.com/v2/listen` (`model=flux-general-en`, `encoding=linear16`, query params for the EOT thresholds) using the Workers `fetch` → `response.webSocket` pattern. Parses 4 event types from JSON messages: `StartOfTurn`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn` → the corresponding callbacks. `sendAudioChunk` forwards raw PCM bytes.

### `workers-ai-flux.ts` — same protocol via Workers AI
Identical event handling; the socket comes from `ai.run("@cf/deepgram/flux", {...}, {websocket: true})` instead of a direct Deepgram API call. This is the default in `wrangler.jsonc` (no Deepgram key needed, inference co-located on Cloudflare).

### `groq.ts` — LLM + tool planner
- `streamAssistantText`: POST `/openai/v1/chat/completions`, `stream:true`, SSE parsing by hand (`\n\n` block split → `data:` lines). Model `meta-llama/llama-4-scout-17b-16e-instruct`, `max_completion_tokens: 128` (voice replies must be short), 20s timeout signal merged with the caller's abort signal. Emits usage stats (incl. Groq timing fields `queue_time` etc.) via `onUsage`. Rich diagnostics if the stream produced no text (finish reasons, tool-call names, last SSE block) — because Groq occasionally returns tool calls or empty streams on this endpoint.
- `GroqRateLimitError` — special-cased by the DO for key rotation.
- `generateBackgroundToolPlanWithNativeCalls`: non-streaming call with the synthetic `submit_actions` tool; parses tool-call arguments (with `jsonrepair` fallback); 400 `tool_use_failed` salvage/retry path described above. Per-tool JSON schemas are hardcoded for every registry tool name (unknown tools get a loose schema).

### `elevenlabs.ts` — streaming TTS, multi-context WS
- `ElevenLabsMultiContextSocket`: one WS to `/v1/text-to-speech/{voice}/multi-stream-input` (`eleven_flash_v2_5`, `pcm_16000`, `auto_mode`). Each assistant turn gets a `contextId` (UUID); messages carry `context_id`, audio comes back base64 per context. `registerContext` returns a `finished` promise resolved on `isFinal` or the idle timer (250ms settle after flush), or a no-audio timeout (1.5s) — these timers are the flush semantics that let the pipeline finish without hanging.
- `ElevenLabsTtsStream`: per-turn wrapper — first message carries `voice_settings`; `flush()` sends `{flush:true}` and awaits `finished`; `close(aborted)` closes the context.
- **Leading-silence trim**: first chunks are buffered until a PCM sample exceeds threshold 256 (`findLeadingSpeechOffset`), then everything is emitted from the speech offset (max window 16KB ≈ 0.5s before bypass). Every provider adapter repeats this same pattern — this is where "no dead air" comes from.
- `synthesizeAssistantAudio` — one-shot helper (used by benchmark/tests).

### `together-orpheus.ts` — HTTP SSE TTS
No persistent socket: each `sendText` POSTs `/v1/audio/speech` (`canopylabs/orpheus-3b-0.1-ft`, voice default `leo`, `response_format:"raw"`, `pcm_s16le`, 24kHz, SSE stream) and pumps `conversation.item.audio_output.delta` events (base64 → PCM). Texts are serialized through a promise queue (one request at a time per turn — Orpheus has no input streaming); `flush` awaits the queue. Same gain + leading-trim treatment (threshold 256, max 24KB window).

### `workers-ai-aura.ts` — Workers AI TTS
`ai.run("@cf/deepgram/aura-2-en", {text, speaker:"luna", encoding:"linear16", container:"wav"}, {returnRawResponse:true})` → WAV byte stream. `parseWavDataOffset` walks RIFF chunks to find the `data` chunk; `takePcmChunk` buffers until the header is parsed, then emits raw PCM. Per-text request, queue-serialized like Orpheus. Same gain + trim.

### `pcm-gain.ts`
`applyPcm16Gain` (linear PCM16 scaling, clamped) + `Pcm16GainProcessor` which keeps a 1-byte carry so odd-sized chunks (WS frame boundaries) don't corrupt int16 alignment. All three TTS adapters run chunks through this.

---

## 8. `src/benchmark/turn-latency.ts`
`TurnLatencyTracker` — first-write-wins marks for 13 milestones (`eagerEndOfTurn`, `endOfTurn`, `llmRequestStarted`, `firstText`, `llmDone`, `ttsReady`, `firstChunkSentToTts`, `firstAudioGenerated`, `audioStartSent`, `firstAudioChunkSent`, `ttsDone`, `playbackStart`, `playbackEnd`). `summarizeLatency` (headline metrics: EOT→firstText / firstAudio / playbackStart) and `summarizeTrace` (the full matrix + audio duration derived from bytes÷sampleRate) power the operational `turn.trace` logs, PostHog `voice_agent_turn_trace`, and the client Gantt.

---

## 9. `src/analytics/posthog.ts`
- Server side: `capturePostHogEvent` POSTs to `/i/v0/e/` (fire-and-forget with `.catch` in the DO).
- Browser side: `buildPostHogBrowserBootstrapScript` — the standard PostHog snippet + `posthog.init` inlined by the worker (with a localStorage distinct id; skipped on localhost). Config also exposed as `window.__POSTHOG_CONFIG__` for `app.js`. Transcript capture is flag-gated (`POSTHOG_CAPTURE_TRANSCRIPTS`).

---

## 10. `src/web/` — frontend (no framework, no build step)

Served as static assets with runtime HTML rewriting for base path. Modules are native ES modules.

### `index.html`
Shell: header (demo fullscreen toggle + settings), orb canvas, status + TTFA timer, start/end buttons, **Scenario pills** (drive-thru / booking / support), **TTS provider segmented control** (aura-2-edge / elevenlabs-flash / together-orpheus), **voice `<select>`** (options tagged with `data-provider-key`, visibility filtered by active provider), transcript + background panels, latency Gantt section, About section. Loads vendored `ort.wasm.min.js` + `vendor/vad/bundle.min.js` before `app.js`.

### `app.js` (~1900 lines) — everything client-side

- **Startup (`startSession`)**: getUserMedia (echoCancellation+noiseSuppression on, **autoGainControl off**) → `setupAudioTransport` (AudioContext + both worklets + gain + analyser) → open WS → wait for `listening` state → then start browser VAD.
- **Capture path**: `pcm-capture-processor` worklet posts 20ms PCM16 frames → `captureWorkletNode.port.onmessage` computes RMS (for ducking) and sends the raw buffer over the WS.
- **Playback path**: binary WS frames → `queueAssistantAudioChunk` — aligns odd bytes (`pendingAssistantPcmByte`), PCM16→Float32, **linear resample** from the TTS sample rate to the AudioContext rate, transferable postMessage to `pcm-playback-processor`. Worklet notifies `playback_started` (first non-queued sample) and `drained` (queue empty + silence) → client sends `turn.assistant.playback.started/ended` acks back to the server (closes the latency loop).
- **Server message handling** (`handleServerMessage`): state → status label + TTFA timer start on `thinking`; transcripts → DOM; `background.turn.update` → background panel (update-in-place per turnId); `turn.trace` → Gantt render + authoritative server-side TTFA display; `audio.start` → new playback segment + `audio.start.received` ack; `turn.interrupted` → clear playback; `session.closed` → graceful teardown.
- **Barge-in**: `@ricky0123/vad-web` (Silero v5, vendored) on the mic stream with a high bar (`positiveSpeechThreshold 0.6`, `minSpeechMs 700`) → on real speech start during assistant playback, `client.interrupt` hint + immediate local playback stop. Independent of the server's own turn detection — belt and suspenders.
- **Ducking**: while assistant audio plays, mic RMS above 0.03 ramps playback gain to 0.4 (60ms attack), back to 1 below 0.015 (240ms release) — partial echo suppression so the agent hears you over itself.
- **Gantt chart** (`renderGanttTurn`): fixed 0–840ms x-axis relative to end-of-turn; 4 lanes (Turn Detection / LLM / TTS / Playback) built from `marksFromEndOfTurnMs`; speculative window shaded when `eagerEndOfTurn < 0`; TTFT/1st-audio/E2E/spec stats in the header; last 2 turns visible with expand button; floating cursor tooltips.
- **Demo mode**: fullscreen = demo; settings panel allows overriding the system prompt and disabling individual tools (sent as `demoOverrides` in `session.start`); desktop-layout viewport switch for mobile.
- **PostHog client events**: page viewed, call start clicked/started/failed, ws dropped, client call ended.

### `audio-worklet.js`
Two processors registered globally:
- `PcmCaptureProcessor`: Float32 input → clamped Int16, buffered to exactly 20ms frames (`sampleRate * 0.02`), posted with transfer.
- `PcmPlaybackProcessor`: queue of Float32 chunks; emits `playback_started` on first sample of a segment, `drained` when the queue empties into silence; `{type:"clear"}` flushes everything (used on interrupt).

### `orb.js`
WebGL2 fragment-shader audio-reactive orb (fbm noise + plosive onset detection from the analyser). Pure visual; `setAnalyser(null)` returns it to idle.

### `slides.html`
Static presentation deck about the project (cursor-hidden fullscreen slides). Not part of the app runtime.

### `vendor/`
`vad/` (Silero VAD bundle + worklet + ONNX model) and `ort/` (onnxruntime-web wasm) — **generated**, do not hand-edit. Managed by `scripts/sync-vad-assets.mjs` (copies from `node_modules/@ricky0123/vad-web/dist` and `onnxruntime-web/dist`; `--check` mode used by `tests/quick/vad-assets.spec.ts` to keep the vendored assets in sync with the lockfile).

### `app.d.ts`, `src/raw.d.ts`
Type shims only (`app.d.ts` is an empty module decl for the untyped JS; `raw.d.ts` supports `*?raw` imports in tests).

---

## 11. `tests/` — vitest, two pools

Layout mirrors delivery phases:

| Suite | Covers |
|---|---|
| `session-foundation/` | WS transport (`audio-transport`), connection failure mapping, session isolation (per-session DO state), base-path serving, mic error UX, start flow. |
| `realtime-voice-loop/` | The heart: `turn-authority` (speculative/cancel/commit semantics — mocks groq + elevenlabs adapters and drives the real `SessionDO`), `interruption-cancel`, `response-pipeline`, transcript/UI state, `interruption-ui`. |
| `deployment-reliability/` | `/api/health` correctness per provider config, deploy config sanity, operational log shape. |
| `quick/` | Pure-unit specs run in plain node: pcm-gain, groq adapter, tool plan, latency contract/streaming, providers runtime, elevenlabs multi-context, aura, orpheus, posthog, vad assets, provider-bench modules. |

Pattern: DO-level tests import the real `SessionDO` but mock the provider adapters with `vi.mock` and scripted streams (including abort-at-chunk behavior to test interruption). UI tests use hand-rolled DOM/WebSocket mocks (no jsdom). Check `vitest.config.ts` for which pool each file lands in when adding tests.

Run: `pnpm test` (all), or per suite `pnpm test:foundation` / `test:voice-loop` / `test:deploy`.

---

## 12. `scripts/`

- `sync-vad-assets.mjs` — see vendor section above.
- `ttft-probe/` — standalone worker (`wrangler.jsonc` + `index.js`) measuring TTFT of Workers AI vs Groq streaming endpoints; `run-benchmark.mjs` is the local runner.
- `provider-bench/` — provider-swap benchmark harness (see its README): `index.js` is a probe worker exposing `POST /llm|/tts|/turn`; runners `run-llm.mjs`, `run-tts.mjs` (first-audio + loudness baseline vs `tts-loudness-baseline.json`), `run-turn.mjs` (turn-detection latency over AMI meeting corpus clips listed in `corpus-manifest.jsonl`), `prepare-corpus.mjs` (downloads corpus into `.cache/`), `audio-analysis.mjs` / `tts-benchmark.mjs` (PCM RMS/loudness analysis). Types in the `.d.ts` files; `tests/quick/provider-bench-*.spec.ts` keep them typechecked.
- `plot-gantt.py` — renders Gantt charts from captured `turn.trace` logs.

---

## 13. Tracing one utterance end-to-end (mental model check)

1. User speaks; browser captures 20ms PCM16 frames → WS binary → DO → Flux session.
2. Flux: `StartOfTurn` (user talking, cancels any uncommitted assistant work) → pause → `EagerEndOfTurn("two burgers and a coke")` at 0.3 conf → DO starts Groq + ElevenLabs **speculatively**; audio buffers.
3. User stays quiet; 0.7 conf → `EndOfTurn` with the same transcript → `commitAssistantTurn` → `turn.user.final` emitted, buffered audio flushed behind `turn.assistant.audio.start` → browser plays. ~150ms from EOT to speaker.
4. Assistant final text emitted → background pass enqueued → Groq planner returns `submit_actions` → cart tools run → `background.turn.update` → panel shows `add_menu_item=ok`.
5. User starts talking mid-reply → Flux `StartOfTurn` (server abort) and/or browser VAD `client.interrupt` → `turn.interrupted`, playback cleared.
6. Next turn's prompt includes hidden notes like `[turn 3 result] completed: add_menu_item=ok {...}` so the agent knows the cart state without the tool lane ever blocking speech.
