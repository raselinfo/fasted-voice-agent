import { createOrb } from "./orb.js";

const startSessionButton = document.querySelector("#start-session-btn");
const endSessionButton = document.querySelector("#end-session-btn");
const ttsVoiceSelect = document.querySelector("#tts-voice-select");
const statusElement = document.querySelector("#session-status");
const errorElement = document.querySelector("#session-error");
const transcriptListElement = document.querySelector("#transcript-list");
const backgroundListElement = document.querySelector("#background-list");
const waterfallContainer = document.querySelector("#waterfall-container");
const orbCanvas = document.querySelector("#orb");
const scenarioPills = document.querySelector("#scenario-pills");
const ttsSegmented = document.querySelector("#tts-provider-segmented");
const ttsSegIndicator = ttsSegmented?.querySelector(".seg-indicator");
const ttfaTimerEl = document.querySelector("#ttfa-timer");

// ── TTFA timer ──
const ttfaTimer = {
  _start: 0,
  _raf: 0,
  _seenFirst: false,
  _tick() {
    if (!this._start) return;
    const ms = Math.round(performance.now() - this._start);
    if (ttfaTimerEl) {
      ttfaTimerEl.textContent = `${ms}ms`;
    }
    if (typeof requestAnimationFrame === "function") {
      this._raf = requestAnimationFrame(() => this._tick());
    }
  },
  start() {
    if (!this._seenFirst) {
      this._seenFirst = true;
      return;
    }
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._raf);
    }
    if (ttfaTimerEl) {
      ttfaTimerEl.textContent = "0ms";
      ttfaTimerEl.classList.remove("stopped");
      ttfaTimerEl.classList.add("visible");
    }
    this._start = performance.now();
    this._tick();
  },
  stop() {
    if (this._start) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this._raf);
      }
      const ms = Math.round(performance.now() - this._start);
      if (ttfaTimerEl) {
        ttfaTimerEl.textContent = `${ms}ms`;
        ttfaTimerEl.classList.add("stopped");
      }
      this._start = 0;
    }
  },
  reset() {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._raf);
    }
    this._start = 0;
    this._seenFirst = false;
    if (ttfaTimerEl) {
      ttfaTimerEl.classList.remove("visible", "stopped");
    }
  },
};

const MIC_DENIED_MESSAGE = "Microphone access denied. Allow microphone and try again.";
const MIC_NOT_FOUND_MESSAGE = "No microphone detected. Connect a microphone and try again.";
const MIC_STARTUP_FAILED_MESSAGE = "Microphone startup failed. Try again.";
const WS_STARTUP_FAILED_MESSAGE = "Could not connect to realtime session. Click Start Session to retry.";
const WS_DROPPED_MESSAGE = "Realtime connection dropped. Click Start Session to retry.";
const SESSION_CLOSED_MESSAGE = "Session ended.";
const VOICE_AGENT_APP_SURFACE = "voice-agent";
const GANTT_COLORS = {
  confirmEot:     '#64748B',
  llmTtft:        '#818CF8',
  llmStream:      '#6366F1',
  ttsBuffer:      '#78716C',
  ttsProcess:     '#FBBF24',
  ttsStream:      '#F59E0B',
  playDelivery:   '#86EFAC',
  playActive:     '#22C55E',
};

const ASSISTANT_PCM_SAMPLE_RATE = 16000;
const BARGE_IN_VAD_POSITIVE_SPEECH_THRESHOLD = 0.6;
const BARGE_IN_VAD_MIN_SPEECH_MS = 700;
const PLAYBACK_DUCK_START_RMS_THRESHOLD = 0.03;
const PLAYBACK_DUCK_END_RMS_THRESHOLD = 0.015;
const PLAYBACK_DUCK_TARGET_GAIN = 0.4;
const PLAYBACK_DUCK_ATTACK_SECONDS = 0.06;
const PLAYBACK_DUCK_RELEASE_SECONDS = 0.24;
const TTS_MODEL_TARGETS = {
  "together-orpheus": {
    provider: "together-orpheus",
    model: "canopylabs/orpheus-3b-0.1-ft",
  },
  "elevenlabs-flash": {
    provider: "elevenlabs",
    model: "eleven_flash_v2_5",
  },
  "aura-2-edge": {
    provider: "workers-ai-aura",
    model: "@cf/deepgram/aura-2-en",
  },
};

if (!(startSessionButton instanceof HTMLButtonElement)) {
  throw new Error("Missing #start-session-btn");
}

if (!(statusElement instanceof HTMLElement)) {
  throw new Error("Missing #session-status");
}

if (!(endSessionButton instanceof HTMLButtonElement)) {
  throw new Error("Missing #end-session-btn");
}

if (!(errorElement instanceof HTMLElement)) {
  throw new Error("Missing #session-error");
}


function updateSegmentIndicator(container, indicator) {
  if (!container || !indicator) {
    return;
  }

  const active = container.querySelector(".seg-btn.active");
  if (!active) {
    return;
  }

  indicator.style.left = `${active.offsetLeft}px`;
  indicator.style.width = `${active.offsetWidth}px`;
}

function setActiveSegmentedValue(container, value) {
  if (!container) {
    return;
  }

  for (const button of container.querySelectorAll(".seg-btn")) {
    button.classList.toggle("active", button.getAttribute("data-value") === value);
  }
}

// Initialize orb on load (idle animation, no analyser yet)
let orb = null;
const orbWrap = document.querySelector(".orb-wrap");
if (typeof HTMLCanvasElement !== "undefined" && orbCanvas instanceof HTMLCanvasElement) {
  orb = createOrb(orbCanvas, null, { qualityMode: "baseline" });
}

class StartupError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const state = {
  startupInFlight: false,
  mediaStream: null,
  socket: null,
  audioContext: null,
  audioSourceNode: null,
  captureWorkletNode: null,
  playbackWorkletNode: null,
  playbackGainNode: null,
  analyserNode: null,
  vad: null,
  isSpeakingPlaybackActive: false,
  playbackDuckingActive: false,
  interruptHintSentForSegment: false,
  activePlaybackSegment: null,
  pendingAssistantPcmByte: null,
  analyticsDistinctId: null,
  analyticsSessionId: null,
  currentSessionId: null,
  currentScenario: null,
  currentTtsConfig: null,
};

function isSelectElement(value) {
  return typeof HTMLSelectElement !== "undefined" && value instanceof HTMLSelectElement;
}

function getOptionProviderKey(option) {
  if (!option || typeof option !== "object") {
    return null;
  }

  if (typeof option.getAttribute === "function") {
    const providerKey = option.getAttribute("data-provider-key");
    return typeof providerKey === "string" && providerKey.length > 0 ? providerKey : null;
  }

  const dataset = "dataset" in option ? option.dataset : null;
  if (dataset && typeof dataset.providerKey === "string" && dataset.providerKey.length > 0) {
    return dataset.providerKey;
  }

  return null;
}

function syncSelectOptionsToProvider(select, providerKey) {
  if (!isSelectElement(select)) {
    return;
  }

  let hasSelectedVisibleOption = false;
  let firstVisibleOptionValue = null;

  for (const option of Array.from(select.options)) {
    const optionProvider = getOptionProviderKey(option);
    const isVisible = optionProvider === providerKey;
    option.hidden = !isVisible;
    option.disabled = !isVisible;

    if (isVisible && firstVisibleOptionValue === null) {
      firstVisibleOptionValue = option.value;
    }

    if (isVisible && option.value === select.value) {
      hasSelectedVisibleOption = true;
    }
  }

  if (!hasSelectedVisibleOption && typeof firstVisibleOptionValue === "string") {
    select.value = firstVisibleOptionValue;
  }
}

function getActiveSegValue() {
  return ttsSegmented?.querySelector(".seg-btn.active")?.getAttribute("data-value") ?? "together-orpheus";
}

function getActiveScenario() {
  return scenarioPills?.querySelector(".pill.active")?.getAttribute("data-value") ?? "drive-thru";
}

function syncTtsOptionsToProvider() {
  const providerKey = getActiveSegValue();
  syncSelectOptionsToProvider(ttsVoiceSelect, providerKey);
}

function updateSessionControls() {
  const hasActiveSession =
    !!state.socket &&
    (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING);
  startSessionButton.disabled = state.startupInFlight || hasActiveSession;
  endSessionButton.disabled = !hasActiveSession;
  const controlsDisabled = state.startupInFlight || hasActiveSession;
  if (ttsSegmented) {
    for (const btn of ttsSegmented.querySelectorAll(".seg-btn")) {
      btn.disabled = controlsDisabled;
    }
  }
  if (scenarioPills) {
    for (const btn of scenarioPills.querySelectorAll(".pill")) {
      btn.disabled = controlsDisabled;
    }
  }
  if (isSelectElement(ttsVoiceSelect)) {
    ttsVoiceSelect.disabled = controlsDisabled;
  }
  if (orbWrap) {
    orbWrap.classList.toggle("orb-active", hasActiveSession);
    orbWrap.classList.toggle("orb-connecting", state.startupInFlight);
  }
}

function setStatus(status) {
  statusElement.textContent = status;
}

function setFeedbackMessage(message, tone = "error") {
  errorElement.textContent = message;
  if (!message) {
    if (typeof errorElement.removeAttribute === "function") {
      errorElement.removeAttribute("data-tone");
    }
    return;
  }
  if (typeof errorElement.setAttribute === "function") {
    errorElement.setAttribute("data-tone", tone);
  }
}

function setError(message) {
  setFeedbackMessage(message, "error");
}

function setNeutralMessage(message) {
  setFeedbackMessage(message, "neutral");
}

function normalizeAppBasePath(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function resolveAppBasePath() {
  const configuredBasePath =
    typeof window === "object" && typeof window.__APP_BASE_PATH__ === "string" ? window.__APP_BASE_PATH__ : "";
  if (configuredBasePath) {
    return normalizeAppBasePath(configuredBasePath);
  }

  const pathname = typeof window?.location?.pathname === "string" ? window.location.pathname : "/";
  if (!pathname || pathname === "/" || pathname === "/index.html") {
    return "";
  }

  if (pathname.endsWith("/index.html")) {
    return normalizeAppBasePath(pathname.slice(0, -"/index.html".length));
  }

  return normalizeAppBasePath(pathname);
}

function buildAppPath(pathname) {
  return `${resolveAppBasePath()}${pathname}`;
}

function getPostHogConfig() {
  if (typeof window !== "object" || !window.__POSTHOG_CONFIG__ || typeof window.__POSTHOG_CONFIG__ !== "object") {
    return null;
  }

  return window.__POSTHOG_CONFIG__;
}

function getPostHog() {
  if (typeof window !== "object" || !window.posthog || typeof window.posthog.capture !== "function") {
    return null;
  }

  return window.posthog;
}

function getPostHogIdentity() {
  const bootstrappedDistinctId =
    typeof window === "object" && typeof window.__VOICE_AGENT_POSTHOG_DISTINCT_ID__ === "string"
      ? window.__VOICE_AGENT_POSTHOG_DISTINCT_ID__.trim()
      : "";
  const posthog = getPostHog();
  if (!posthog) {
    return {
      distinctId: bootstrappedDistinctId || null,
      sessionId: null,
    };
  }

  const distinctId =
    typeof posthog.get_distinct_id === "function" && typeof posthog.get_distinct_id() === "string"
      ? posthog.get_distinct_id().trim()
      : "";
  const sessionId =
    typeof posthog.get_session_id === "function" && typeof posthog.get_session_id() === "string"
      ? posthog.get_session_id().trim()
      : "";

  return {
    distinctId: distinctId || bootstrappedDistinctId || null,
    sessionId: sessionId || null,
  };
}

function syncAnalyticsIdentity() {
  const identity = getPostHogIdentity();
  state.analyticsDistinctId = identity.distinctId;
  state.analyticsSessionId = identity.sessionId;
  return identity;
}

function capturePostHog(event, properties = {}) {
  const posthog = getPostHog();
  if (!posthog) {
    return;
  }

  posthog.capture(event, {
    app_surface: getPostHogConfig()?.appSurface ?? VOICE_AGENT_APP_SURFACE,
    ...properties,
  });
}

function buildCallAnalyticsProperties(extraProperties = {}) {
  return {
    call_session_id: state.currentSessionId,
    scenario: state.currentScenario,
    tts_provider: state.currentTtsConfig?.provider ?? null,
    tts_model: state.currentTtsConfig?.model ?? null,
    tts_voice: state.currentTtsConfig?.voice ?? null,
    posthog_distinct_id: state.analyticsDistinctId,
    posthog_session_id: state.analyticsSessionId,
    ...extraProperties,
  };
}

function resetCallAnalyticsState() {
  state.currentSessionId = null;
  state.currentScenario = null;
  state.currentTtsConfig = null;
}

function getSessionSocketUrl(sessionId) {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const sessionPath = buildAppPath("/api/session");
  return `${wsProtocol}//${window.location.host}${sessionPath}?sessionId=${encodeURIComponent(sessionId)}`;
}

function getTtsConfig() {
  const providerKey = getActiveSegValue();
  const target = providerKey ? TTS_MODEL_TARGETS[providerKey] : null;
  const model = target?.model ?? null;
  const voice = isSelectElement(ttsVoiceSelect) && ttsVoiceSelect.value ? ttsVoiceSelect.value : null;
  const provider = target?.provider ?? null;

  if (!provider && !model && !voice) {
    return undefined;
  }

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
  };
}

function getSessionScenario() {
  return getActiveScenario();
}

function resetPlaybackState() {
  state.activePlaybackSegment = null;
  state.isSpeakingPlaybackActive = false;
  state.playbackDuckingActive = false;
  state.interruptHintSentForSegment = false;
  state.pendingAssistantPcmByte = null;
  applyPlaybackGain(1, PLAYBACK_DUCK_RELEASE_SECONDS);
}

function maybeNotifyPlaybackEnded() {
  const assistantTurnId = state.activePlaybackSegment?.assistantTurnId;
  if (
    !assistantTurnId ||
    !state.activePlaybackSegment?.audioEndReceived ||
    !state.activePlaybackSegment?.playbackDrained ||
    state.activePlaybackSegment?.playbackEndedNotified
  ) {
    return false;
  }

  state.activePlaybackSegment.playbackEndedNotified = true;
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(
      JSON.stringify({
        type: "turn.assistant.playback.ended",
        assistantTurnId,
        clientTsMs: Date.now(),
      }),
    );
  }
  resetPlaybackState();
  if (state.socket?.readyState === WebSocket.OPEN) {
    setStatus("listening");
  }
  return true;
}

function clearPlaybackQueue() {
  state.playbackWorkletNode?.port?.postMessage?.({ type: "clear" });
}

function stopPlaybackImmediately() {
  clearPlaybackQueue();
  resetPlaybackState();
}

function applyPlaybackGain(nextGain, rampSeconds = 0) {
  const gainParam = state.playbackGainNode?.gain;
  if (!gainParam) {
    return;
  }

  const now =
    state.audioContext && typeof state.audioContext.currentTime === "number" ? state.audioContext.currentTime : 0;

  if (typeof gainParam.cancelScheduledValues === "function") {
    gainParam.cancelScheduledValues(now);
  }

  if (typeof gainParam.setTargetAtTime === "function") {
    const timeConstant = Math.max(rampSeconds / 3, 0.01);
    gainParam.setTargetAtTime(nextGain, now, timeConstant);
  } else if (typeof gainParam.setValueAtTime === "function") {
    gainParam.setValueAtTime(nextGain, now);
  } else {
    gainParam.value = nextGain;
  }
}

function updatePlaybackDucking(rms) {
  if (!state.isSpeakingPlaybackActive || !state.playbackGainNode) {
    if (state.playbackDuckingActive) {
      state.playbackDuckingActive = false;
      applyPlaybackGain(1, PLAYBACK_DUCK_RELEASE_SECONDS);
    }
    return;
  }

  if (state.playbackDuckingActive) {
    if (rms <= PLAYBACK_DUCK_END_RMS_THRESHOLD) {
      state.playbackDuckingActive = false;
      applyPlaybackGain(1, PLAYBACK_DUCK_RELEASE_SECONDS);
    }
    return;
  }

  if (rms >= PLAYBACK_DUCK_START_RMS_THRESHOLD) {
    state.playbackDuckingActive = true;
    applyPlaybackGain(PLAYBACK_DUCK_TARGET_GAIN, PLAYBACK_DUCK_ATTACK_SECONDS);
  }
}

function getMicVadFactory() {
  if (typeof window !== "object" || !window.vad || !window.vad.MicVAD || typeof window.vad.MicVAD.new !== "function") {
    return null;
  }

  return window.vad.MicVAD;
}

function sendClientInterruptHint(socket) {
  if (
    !state.isSpeakingPlaybackActive ||
    state.interruptHintSentForSegment ||
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return false;
  }

  stopPlaybackImmediately();
  state.interruptHintSentForSegment = true;
  setStatus("interrupted");
  socket.send(JSON.stringify({ type: "client.interrupt" }));
  return true;
}

async function setupBrowserVad(mediaStream, audioContext) {
  if (!mediaStream || !audioContext) {
    return;
  }

  const MicVAD = getMicVadFactory();
  if (!MicVAD) {
    return;
  }

  let vadInstance;
  try {
    vadInstance = await MicVAD.new({
      audioContext,
      model: "v5",
      startOnLoad: false,
      baseAssetPath: buildAppPath("/vendor/vad/"),
      onnxWASMBasePath: buildAppPath("/vendor/ort/"),
      positiveSpeechThreshold: BARGE_IN_VAD_POSITIVE_SPEECH_THRESHOLD,
      minSpeechMs: BARGE_IN_VAD_MIN_SPEECH_MS,
      getStream: async () => mediaStream,
      pauseStream: async () => {},
      resumeStream: async () => mediaStream,
      onSpeechRealStart: async () => {
        sendClientInterruptHint(state.socket);
      },
    });
  } catch (error) {
    console.warn("MicVAD initialization failed.", error);
    return;
  }

  if (state.mediaStream !== mediaStream || state.audioContext !== audioContext || state.vad) {
    try {
      await vadInstance.destroy?.();
    } catch {
      // Ignore teardown races if the session changed while VAD was initializing.
    }
    return;
  }

  state.vad = vadInstance;
  try {
    await vadInstance.start?.();
  } catch (error) {
    if (state.vad === vadInstance) {
      state.vad = null;
    }
    try {
      await vadInstance.destroy?.();
    } catch {
      // Ignore follow-up teardown failures after a startup error.
    }
    console.warn("MicVAD start failed.", error);
  }
}

function cleanupAudioTransport() {
  stopPlaybackImmediately();

  if (state.vad && typeof state.vad.destroy === "function") {
    void state.vad.destroy();
  }
  state.vad = null;

  if (state.audioSourceNode && typeof state.audioSourceNode.disconnect === "function") {
    state.audioSourceNode.disconnect();
  }
  if (state.captureWorkletNode && typeof state.captureWorkletNode.disconnect === "function") {
    state.captureWorkletNode.disconnect();
  }
  if (state.playbackWorkletNode && typeof state.playbackWorkletNode.disconnect === "function") {
    state.playbackWorkletNode.disconnect();
  }
  if (state.playbackGainNode && typeof state.playbackGainNode.disconnect === "function") {
    state.playbackGainNode.disconnect();
  }
  if (state.analyserNode && typeof state.analyserNode.disconnect === "function") {
    state.analyserNode.disconnect();
  }
  if (state.audioContext && typeof state.audioContext.close === "function") {
    void state.audioContext.close();
  }

  state.audioSourceNode = null;
  state.captureWorkletNode = null;
  state.playbackWorkletNode = null;
  state.playbackGainNode = null;
  state.analyserNode = null;
  state.audioContext = null;

  // Return orb to idle
  if (orb) {
    orb.setAnalyser(null);
  }
}

function cleanupMedia() {
  cleanupAudioTransport();

  if (!state.mediaStream) {
    return;
  }

  for (const track of state.mediaStream.getTracks()) {
    track.stop();
  }
  state.mediaStream = null;
}

function extractCaptureFrame(data) {
  if (!data || typeof data !== "object" || data.type !== "capture" || !(data.buffer instanceof ArrayBuffer)) {
    return null;
  }

  return {
    buffer: data.buffer,
    sampleRate: typeof data.sampleRate === "number" ? data.sampleRate : null,
  };
}

function computeRmsFromPcm16(buffer) {
  const samples = new Int16Array(buffer);
  if (samples.length === 0) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = samples[index] / 0x8000;
    total += normalized * normalized;
  }

  return Math.sqrt(total / samples.length);
}

// ── Transcript rendering ──

function appendTranscriptEntry(role, turnId, text) {
  if (!transcriptListElement) {
    return;
  }

  const entry = document.createElement("div");
  entry.className = "message";
  entry.setAttribute("data-role", role);
  entry.setAttribute("data-turn-id", String(turnId));

  const roleSpan = document.createElement("span");
  roleSpan.className = "message-role";
  roleSpan.textContent = role === "user" ? "you" : "agent";

  const textSpan = document.createElement("span");
  textSpan.className = "message-text";
  textSpan.textContent = text;

  entry.appendChild(roleSpan);
  entry.appendChild(textSpan);
  transcriptListElement.appendChild(entry);
  transcriptListElement.scrollTop = transcriptListElement.scrollHeight;
}

function resetConversationUi() {
  if (transcriptListElement && typeof transcriptListElement.replaceChildren === "function") {
    transcriptListElement.replaceChildren();
  }
  if (backgroundListElement && typeof backgroundListElement.replaceChildren === "function") {
    backgroundListElement.replaceChildren();
  }
  if (waterfallContainer && typeof waterfallContainer.replaceChildren === "function") {
    waterfallContainer.replaceChildren();
  }
  ganttExpanded = false;
  if (ganttExpandBtn) {
    ganttExpandBtn.hidden = true;
  }
}

// ── Background panel rendering (update-in-place) ──

function formatToolOutput(output) {
  if (output == null) return null;
  if (typeof output === "string") return output.length > 80 ? output.slice(0, 77) + "..." : output;
  if (typeof output === "object") {
    // Try to make a readable summary from key-value pairs
    const entries = Object.entries(output);
    if (entries.length === 0) return null;
    const parts = entries.slice(0, 4).map(([k, v]) => {
      const val = typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v);
      return `${k}: ${val}`;
    });
    const s = parts.join(", ");
    return s.length > 80 ? s.slice(0, 77) + "..." : s;
  }
  return String(output);
}

function updateBackgroundEntry(turnId, status, summary, actions) {
  if (!backgroundListElement) {
    return;
  }

  let entry = backgroundListElement.querySelector(`[data-turn-id="${turnId}"]`);
  if (!entry) {
    entry = document.createElement("div");
    entry.className = "bg-entry";
    entry.setAttribute("data-turn-id", String(turnId));
    backgroundListElement.appendChild(entry);
  }

  entry.setAttribute("data-status", status);

  let html = "";

  if (status === "pending") {
    html += '<span class="bg-entry-label">Waiting...</span>';
  } else if (status === "in_progress") {
    html += '<span class="bg-entry-label">Processing...</span>';
  } else if (status === "failed") {
    html += `<div class="bg-entry-detail bg-tool-err">${escapeHtml(summary)}</div>`;
  } else if (status === "completed" && Array.isArray(actions) && actions.length > 0) {
    for (const action of actions) {
      html += '<div class="bg-tool-call">';
      html += `<span class="bg-tool-name">${escapeHtml(action.tool)}</span>`;
      if (action.ok) {
        const result = formatToolOutput(action.output);
        if (result) {
          html += `<div class="bg-tool-result">${escapeHtml(result)}</div>`;
        }
      } else {
        html += `<div class="bg-tool-result bg-tool-err">${escapeHtml(action.error || "failed")}</div>`;
      }
      html += "</div>";
    }
  } else {
    html += `<span class="bg-entry-detail">${escapeHtml(summary)}</span>`;
  }

  entry.innerHTML = html;
  backgroundListElement.scrollTop = backgroundListElement.scrollHeight;
}

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Gantt chart rendering ──

function renderGanttTurn(turnId, marks) {
  if (!waterfallContainer) {
    return;
  }

  // Extract milestones (all relative to endOfTurn = 0)
  const eagerEot = marks.eagerEndOfTurn;
  const llmStart = marks.llmRequestStarted ?? 0;
  const firstText = marks.firstText;
  const llmDone = marks.llmDone;
  const firstChunkToTts = marks.firstChunkSentToTts;
  const firstAudio = marks.firstAudioGenerated;
  const ttsDone = marks.ttsDone;
  const audioStartSent = marks.audioStartSent;
  const playbackStart = marks.playbackStart;
  const playbackEnd = marks.playbackEnd;

  // Fixed x-axis: 0 to 800ms (with small left pad for speculative marks)
  const paddedMin = (marks.eagerEndOfTurn != null && marks.eagerEndOfTurn < 0)
    ? Math.min(marks.eagerEndOfTurn - 20, -40)
    : -40;
  const paddedMax = 840;
  const range = paddedMax - paddedMin;

  function toPercent(ms) {
    return ((ms - paddedMin) / range) * 100;
  }

  function createBar(cls, startMs, endMs, label) {
    if (startMs == null || endMs == null || endMs <= startMs) {
      return null;
    }
    const el = document.createElement("div");
    el.className = `gantt-bar ${cls}`;
    const left = Math.max(0, toPercent(startMs));
    const right = Math.min(100, toPercent(endMs));
    if (right <= left) return null;
    el.style.left = `${left}%`;
    el.style.width = `${right - left}%`;
    el.style.minWidth = "2px";
    el.dataset.tipHtml = `<strong>${label}</strong><br>${Math.round(startMs)}ms → ${Math.round(endMs)}ms<br><span class="gantt-tooltip-dur">${Math.round(endMs - startMs)}ms</span>`;
    return el;
  }

  // Build .gantt-turn
  const turnEl = document.createElement("div");
  turnEl.className = "gantt-turn";
  turnEl.setAttribute("data-turn-id", String(turnId));

  // Build .gantt-header
  const header = document.createElement("div");
  header.className = "gantt-header";

  const turnLabel = document.createElement("span");
  turnLabel.className = "gantt-turn-label";
  turnLabel.textContent = `Turn ${turnId}`;
  header.appendChild(turnLabel);

  // Stats
  const statsSpan = document.createElement("span");
  statsSpan.className = "gantt-stats";
  const statParts = [];
  if (firstText != null && firstText >= 0) {
    statParts.push(`<span class="gantt-stat-value">TTFT ${Math.round(firstText)}</span> ms`);
  }
  if (firstAudio != null && firstAudio >= 0) {
    statParts.push(`<span class="gantt-stat-value">1st audio ${Math.round(firstAudio)}</span> ms`);
  }
  if (playbackStart != null && playbackStart >= 0) {
    statParts.push(`<span class="gantt-stat-value">E2E ${Math.round(playbackStart)}</span> ms`);
  }
  if (eagerEot != null && eagerEot < 0) {
    statParts.push(`<span class="gantt-stat-value">spec ${Math.round(Math.abs(eagerEot))}</span> ms`);
  }
  statsSpan.innerHTML = statParts.join("&nbsp;&nbsp;");
  header.appendChild(statsSpan);

  // Build .gantt-chart
  const chart = document.createElement("div");
  chart.className = "gantt-chart";

  // Speculative shade
  if (eagerEot != null && eagerEot < 0) {
    const shade = document.createElement("div");
    shade.className = "gantt-spec-shade";
    shade.style.left = `${toPercent(eagerEot)}%`;
    shade.style.width = `${toPercent(0) - toPercent(eagerEot)}%`;
    chart.appendChild(shade);
  }

  // Vertical markers
  function addMarker(cls, ms, labelText, tooltip) {
    const pct = toPercent(ms);
    if (pct < 0 || pct > 100) return;
    const marker = document.createElement("div");
    marker.className = `gantt-marker ${cls}`;
    marker.style.left = `${pct}%`;
    const mLabel = document.createElement("span");
    mLabel.className = "gantt-marker-label";
    mLabel.textContent = labelText;
    if (tooltip) {
      mLabel.dataset.tipText = tooltip;
      mLabel.style.cursor = "help";
      mLabel.style.pointerEvents = "auto";
    }
    marker.appendChild(mLabel);
    chart.appendChild(marker);
  }

  // EOT marker (always at 0)
  addMarker("marker-eot", 0, "EOT 0ms", "End of Turn. When the user stopped speaking.");

  // Eager EOT marker
  if (eagerEot != null && eagerEot < 0) {
    addMarker("marker-eager-eot", eagerEot, `Eager EOT ${Math.round(eagerEot)}ms`, "Speculative end-of-turn. Processing started early before final confirmation.");
  }

  // TTFT marker (only show if positive — negative means speculative, already covered by eager EOT)
  if (firstText != null && firstText >= 0) {
    addMarker("marker-ttft", firstText, `TTFT +${Math.round(firstText)}ms`, "Time to First Token. When the LLM produced its first word.");
  }

  // 1st audio marker (only show if positive)
  if (firstAudio != null && firstAudio >= 0) {
    addMarker("marker-audio", firstAudio, `1st audio +${Math.round(firstAudio)}ms`, "First audio generated. When the TTS produced its first audio chunk.");
  }

  // Lane 1: Turn Detection
  const lane1 = document.createElement("div");
  lane1.className = "gantt-lane";
  const lane1Label = document.createElement("span");
  lane1Label.className = "gantt-lane-label";
  lane1Label.textContent = "Turn Detection";
  lane1.appendChild(lane1Label);
  if (eagerEot != null && eagerEot < 0) {
    const b = createBar("confirm-eot", eagerEot, 0, "EOT confirm");
    if (b) lane1.appendChild(b);
  }
  chart.appendChild(lane1);

  // Lane 2: LLM
  const lane2 = document.createElement("div");
  lane2.className = "gantt-lane";
  const lane2Label = document.createElement("span");
  lane2Label.className = "gantt-lane-label";
  lane2Label.textContent = "LLM";
  lane2.appendChild(lane2Label);
  const llmTtftBar = createBar("llm-ttft", llmStart, firstText, "LLM (TTFT)");
  if (llmTtftBar) lane2.appendChild(llmTtftBar);
  const llmStreamBar = createBar("llm-stream", firstText, llmDone, "LLM (stream)");
  if (llmStreamBar) lane2.appendChild(llmStreamBar);
  chart.appendChild(lane2);

  // Lane 3: TTS
  const lane3 = document.createElement("div");
  lane3.className = "gantt-lane";
  const lane3Label = document.createElement("span");
  lane3Label.className = "gantt-lane-label";
  lane3Label.textContent = "TTS";
  lane3.appendChild(lane3Label);
  const ttsBufferBar = createBar("tts-buffer", firstText, firstChunkToTts, "TTS (buffering)");
  if (ttsBufferBar) lane3.appendChild(ttsBufferBar);
  const ttsProcessBar = createBar("tts-process", firstChunkToTts, firstAudio, "TTS (processing)");
  if (ttsProcessBar) lane3.appendChild(ttsProcessBar);
  const ttsStreamBar = createBar("tts-stream", firstAudio, ttsDone, "TTS (streaming)");
  if (ttsStreamBar) lane3.appendChild(ttsStreamBar);
  chart.appendChild(lane3);

  // Lane 4: Playback
  const lane4 = document.createElement("div");
  lane4.className = "gantt-lane";
  const lane4Label = document.createElement("span");
  lane4Label.className = "gantt-lane-label";
  lane4Label.textContent = "Playback";
  lane4.appendChild(lane4Label);
  const deliveryStart = audioStartSent ?? firstAudio;
  const playDeliveryBar = createBar("play-delivery", deliveryStart, playbackStart, "Delivery");
  if (playDeliveryBar) lane4.appendChild(playDeliveryBar);
  const playEnd = playbackEnd ?? (playbackStart != null ? paddedMax : null);
  const playActiveBar = createBar("play-active", playbackStart, playEnd, "Playback");
  if (playActiveBar) lane4.appendChild(playActiveBar);
  chart.appendChild(lane4);

  // Assemble
  turnEl.appendChild(header);
  turnEl.appendChild(chart);

  // Update in-place if this turn already exists, otherwise prepend
  const existing = waterfallContainer.querySelector(`[data-turn-id="${turnId}"]`);
  if (existing) {
    existing.replaceWith(turnEl);
  } else {
    waterfallContainer.prepend(turnEl);
  }
  enforceGanttLimit();
}

const GANTT_VISIBLE_LIMIT = 2;
const ganttExpandBtn = document.querySelector("#gantt-expand-btn");
let ganttExpanded = false;

function enforceGanttLimit() {
  if (!waterfallContainer || ganttExpanded) return;
  const turns = waterfallContainer.querySelectorAll(".gantt-turn");
  let hiddenCount = 0;
  for (let i = 0; i < turns.length; i++) {
    if (i < GANTT_VISIBLE_LIMIT) {
      turns[i].classList.remove("gantt-hidden");
    } else {
      turns[i].classList.add("gantt-hidden");
      hiddenCount++;
    }
  }
  if (ganttExpandBtn) {
    ganttExpandBtn.hidden = hiddenCount === 0;
  }
}

if (ganttExpandBtn) {
  ganttExpandBtn.addEventListener("click", () => {
    ganttExpanded = true;
    if (waterfallContainer) {
      for (const turn of waterfallContainer.querySelectorAll(".gantt-turn")) {
        turn.classList.remove("gantt-hidden");
      }
    }
    ganttExpandBtn.hidden = true;
  });
}

// ── Cursor-following tooltips for gantt ──

// Single floating tooltip element on body
{
  const tip = document.createElement("div");
  tip.className = "gantt-float-tip";
  if (document.body && typeof document.body.appendChild === "function") {
    document.body.appendChild(tip);
  }

  if (typeof document.addEventListener === "function") {
    document.addEventListener("mousemove", (e) => {
      const target = e.target;
      const bar = target?.closest?.(".gantt-bar");
      if (bar && bar.dataset.tipHtml) {
        tip.innerHTML = bar.dataset.tipHtml;
        tip.style.whiteSpace = "nowrap";
        tip.style.width = "";
        tip.style.left = `${e.clientX + 14}px`;
        tip.style.top = `${e.clientY + 14}px`;
        tip.style.display = "block";
        return;
      }
      const label = target?.closest?.(".gantt-marker-label");
      if (label && label.dataset.tipText) {
        tip.textContent = label.dataset.tipText;
        tip.style.whiteSpace = "normal";
        tip.style.width = "220px";
        tip.style.left = `${e.clientX + 14}px`;
        tip.style.top = `${e.clientY + 14}px`;
        tip.style.display = "block";
        return;
      }
      tip.style.display = "none";
    });
  }
}

// ── PCM helpers ──

function pcm16ToFloat32(buffer) {
  const input = new Int16Array(buffer);
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = input[index] / 0x8000;
  }
  return output;
}

function resampleFloat32(samples, fromRate, toRate) {
  if (samples.length === 0 || fromRate === toRate) {
    return samples;
  }

  const targetLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const resampled = new Float32Array(targetLength);
  const ratio = fromRate / toRate;

  for (let index = 0; index < targetLength; index += 1) {
    const position = index * ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const weight = position - leftIndex;
    resampled[index] = samples[leftIndex] * (1 - weight) + samples[rightIndex] * weight;
  }

  return resampled;
}

function queueAssistantAudioChunk(buffer) {
  if (!state.playbackWorkletNode || !state.audioContext || !state.activePlaybackSegment) {
    return;
  }

  const chunkBytes = new Uint8Array(buffer);
  const needsPrefixByte = typeof state.pendingAssistantPcmByte === "number";
  const mergedLength = chunkBytes.byteLength + (needsPrefixByte ? 1 : 0);
  if (mergedLength < 2) {
    state.pendingAssistantPcmByte = chunkBytes.byteLength === 1 ? chunkBytes[0] : state.pendingAssistantPcmByte;
    return;
  }

  const mergedBytes = new Uint8Array(mergedLength);
  if (needsPrefixByte) {
    mergedBytes[0] = state.pendingAssistantPcmByte;
    mergedBytes.set(chunkBytes, 1);
    state.pendingAssistantPcmByte = null;
  } else {
    mergedBytes.set(chunkBytes, 0);
  }

  const alignedLength = mergedBytes.byteLength - (mergedBytes.byteLength % 2);
  if (alignedLength !== mergedBytes.byteLength) {
    state.pendingAssistantPcmByte = mergedBytes[mergedBytes.byteLength - 1];
  }

  if (alignedLength <= 0) {
    return;
  }

  const alignedBytes = alignedLength === mergedBytes.byteLength ? mergedBytes : mergedBytes.slice(0, alignedLength);
  const playbackRate = state.audioContext.sampleRate;
  const sourceRate = state.activePlaybackSegment.sampleRate || ASSISTANT_PCM_SAMPLE_RATE;
  const floatSamples = pcm16ToFloat32(alignedBytes.buffer);
  const resampled = resampleFloat32(floatSamples, sourceRate, playbackRate);

  state.playbackWorkletNode.port.postMessage(
    {
      type: "enqueue",
      buffer: resampled.buffer,
    },
    [resampled.buffer],
  );
}

// ── Message handling ──

function handleServerMessage(socket, rawData) {
  if (socket !== state.socket) {
    return;
  }

  if (rawData instanceof ArrayBuffer) {
    queueAssistantAudioChunk(rawData);
    return;
  }

  if (ArrayBuffer.isView(rawData)) {
    queueAssistantAudioChunk(rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength));
    return;
  }

  if (typeof rawData !== "string") {
    return;
  }

  let message;
  try {
    message = JSON.parse(rawData);
  } catch {
    return;
  }

  switch (message.type) {
    case "session.state":
      if (typeof message.state === "string") {
        setStatus(message.state);
        if (message.state === "thinking") ttfaTimer.start();
      }
      break;
    case "session.error":
      setStatus("error");
      if (typeof message.message === "string") {
        setError(message.message);
      }
      break;
    case "turn.user.final":
      appendTranscriptEntry("user", message.turnId, message.text);
      break;
    case "turn.assistant.final":
      appendTranscriptEntry("assistant", message.assistantTurnId, message.text);
      break;
    case "background.turn.update":
      if (
        typeof message.turnId === "number" &&
        typeof message.status === "string" &&
        typeof message.summary === "string"
      ) {
        if (Array.isArray(message.actions)) {
          for (const action of message.actions) {
            if (action && action.ok === false) {
              console.error("background action failed", {
                turnId: message.turnId,
                status: message.status,
                tool: action.tool,
                error: action.error,
              });
            }
          }
        }
        updateBackgroundEntry(message.turnId, message.status, message.summary, message.actions);
      }
      break;
    case "turn.trace":
      if (typeof message.assistantTurnId === "number" && message.marksFromEndOfTurnMs) {
        renderGanttTurn(message.assistantTurnId, message.marksFromEndOfTurnMs);
        const serverTtfa = message.marksFromEndOfTurnMs.firstAudioGenerated;
        if (ttfaTimerEl && serverTtfa != null && serverTtfa >= 0) {
          ttfaTimerEl.textContent = `${Math.round(serverTtfa)}ms`;
        }
      }
      break;
    case "turn.assistant.audio.start":
      ttfaTimer.stop();
      clearPlaybackQueue();
      state.activePlaybackSegment = {
        assistantTurnId: message.assistantTurnId,
        sampleRate: message.sampleRate,
        playbackStartedNotified: false,
        audioEndReceived: false,
        playbackDrained: false,
        playbackEndedNotified: false,
      };
      state.isSpeakingPlaybackActive = true;
      state.playbackDuckingActive = false;
      applyPlaybackGain(1, 0);
      state.interruptHintSentForSegment = false;
      if (state.socket?.readyState === WebSocket.OPEN) {
        state.socket.send(
          JSON.stringify({
            type: "turn.assistant.audio.start.received",
            assistantTurnId: message.assistantTurnId,
            clientTsMs: Date.now(),
          }),
        );
      }
      break;
    case "turn.assistant.audio.end":
      if (state.activePlaybackSegment?.assistantTurnId === message.assistantTurnId) {
        state.activePlaybackSegment.audioEndReceived = true;
        maybeNotifyPlaybackEnded();
      }
      break;
    case "turn.interrupted":
      stopPlaybackImmediately();
      break;
    case "session.closed":
      handleSessionClosed(socket, message.reason);
      break;
    case "session.ready":
    default:
      break;
  }
}

// ── Audio transport ──

async function setupAudioTransport(mediaStream) {
  cleanupAudioTransport();

  const audioContext = new AudioContext({ latencyHint: "interactive" });
  await audioContext.audioWorklet.addModule(buildAppPath("/audio-worklet.js"));

  const sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const captureWorkletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  });
  const playbackWorkletNode = new AudioWorkletNode(audioContext, "pcm-playback-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    channelCount: 1,
  });
  const playbackGainNode = typeof audioContext.createGain === "function" ? audioContext.createGain() : null;
  if (playbackGainNode?.gain) {
    playbackGainNode.gain.value = 1;
  }

  // Create AnalyserNode for orb visualization
  const analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.4;

  state.audioContext = audioContext;
  state.audioSourceNode = sourceNode;
  state.captureWorkletNode = captureWorkletNode;
  state.playbackWorkletNode = playbackWorkletNode;
  state.playbackGainNode = playbackGainNode;
  state.analyserNode = analyserNode;

  captureWorkletNode.port.onmessage = (event) => {
    const frame = extractCaptureFrame(event.data);
    if (!frame || frame.sampleRate !== audioContext.sampleRate) {
      return;
    }

    updatePlaybackDucking(computeRmsFromPcm16(frame.buffer));

    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    state.socket.send(frame.buffer);
  };

  playbackWorkletNode.port.onmessage = (event) => {
    if (event.data?.type === "playback_started") {
      const assistantTurnId = state.activePlaybackSegment?.assistantTurnId;
      if (!assistantTurnId || state.activePlaybackSegment?.playbackStartedNotified) {
        return;
      }

      state.activePlaybackSegment.playbackStartedNotified = true;
      if (state.socket?.readyState === WebSocket.OPEN) {
        state.socket.send(
          JSON.stringify({
            type: "turn.assistant.playback.started",
            assistantTurnId,
            clientTsMs: Date.now(),
          }),
        );
      }
      return;
    }

    if (event.data?.type === "drained") {
      if (!state.activePlaybackSegment) {
        return;
      }

      state.activePlaybackSegment.playbackDrained = true;
      maybeNotifyPlaybackEnded();
    }
  };

  // Wire audio graph:
  // sourceNode (mic) --> captureWorkletNode (PCM to server)
  // sourceNode (mic) --> analyserNode (visualization only, NOT to destination)
  // playbackWorkletNode --> playbackGainNode --> destination (speakers)
  // playbackWorkletNode --> analyserNode (visualization only)
  sourceNode.connect(captureWorkletNode);
  sourceNode.connect(analyserNode);
  if (playbackGainNode) {
    playbackWorkletNode.connect(playbackGainNode);
    playbackGainNode.connect(audioContext.destination);
  } else {
    playbackWorkletNode.connect(audioContext.destination);
  }
  playbackWorkletNode.connect(analyserNode);

  // Wire orb to analyser
  if (orb) {
    orb.setAnalyser(analyserNode);
  }
}

// ── Session connection ──

function handleRealtimeDrop(socket) {
  if (state.socket !== socket) {
    return;
  }

  capturePostHog("voice_agent_ws_dropped", buildCallAnalyticsProperties({ reason: "ws_dropped" }));
  cleanupMedia();
  state.socket = null;
  resetCallAnalyticsState();
  setStatus("error");
  setError(WS_DROPPED_MESSAGE);
  updateSessionControls();
}

function handleSessionClosed(socket, reason) {
  if (state.socket !== socket) {
    return;
  }

  capturePostHog(
    "voice_agent_client_call_ended",
    buildCallAnalyticsProperties({
      reason: typeof reason === "string" && reason.length > 0 ? reason : "session_closed",
    }),
  );
  cleanupMedia();
  state.socket = null;
  resetCallAnalyticsState();
  ttfaTimer.reset();
  setStatus("idle");
  setNeutralMessage(typeof reason === "string" && reason.length > 0 ? reason : SESSION_CLOSED_MESSAGE);
  updateSessionControls();

  if (socket.readyState !== WebSocket.CLOSED) {
    try {
      socket.close(1000, "Session closed");
    } catch {
      // Ignore close races while acknowledging a server-closed session.
    }
  }
}

function attachDropHandlers(socket) {
  socket.addEventListener("close", () => {
    handleRealtimeDrop(socket);
  });
  socket.addEventListener("error", () => {
    handleRealtimeDrop(socket);
  });
}

function connectSessionSocket(sessionId, sampleRate, ttsConfig, scenario, analytics) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(getSessionSocketUrl(sessionId));
    socket.binaryType = "arraybuffer";
    let settled = false;

    socket.addEventListener("message", (event) => {
      handleServerMessage(socket, event.data);

      if (settled || typeof event.data !== "string") {
        return;
      }

      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message?.type === "session.state" && message.state === "listening") {
        settled = true;
        resolve(socket);
        return;
      }

      if (message?.type === "session.error") {
        rejectOnce(typeof message.message === "string" ? message.message : undefined);
        return;
      }

      if (message?.type === "session.state" && message.state === "error") {
        rejectOnce();
      }
    });

    const rejectOnce = (message = WS_STARTUP_FAILED_MESSAGE) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // Ignore close races while rejecting startup.
      }
      reject(new StartupError("ws-connect-failed", message));
    };

    socket.addEventListener(
      "open",
      () => {
        socket.send(
          JSON.stringify({
            type: "session.start",
            sessionId,
            sampleRate,
            audioFormat: {
              encoding: "pcm16",
              channels: 1,
            },
            ...(analytics && (analytics.distinctId || analytics.sessionId) ? { analytics } : {}),
            ...(typeof scenario === "string" && scenario.length > 0 ? { scenario } : {}),
            ...(ttsConfig ? { ttsConfig } : {}),
          }),
        );
      },
      { once: true },
    );

    socket.addEventListener(
      "error",
      () => {
        rejectOnce();
      },
      { once: true },
    );

    socket.addEventListener(
      "close",
      () => {
        rejectOnce();
      },
      { once: true },
    );
  });
}

function mapStartupError(error) {
  const errorName =
    error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : null;

  if (errorName === "NotAllowedError") {
    return MIC_DENIED_MESSAGE;
  }

  if (errorName === "NotFoundError") {
    return MIC_NOT_FOUND_MESSAGE;
  }

  if (error instanceof StartupError && error.kind === "ws-connect-failed") {
    return error.message || WS_STARTUP_FAILED_MESSAGE;
  }

  return MIC_STARTUP_FAILED_MESSAGE;
}

function logMicCaptureSettings(stream) {
  const track = stream?.getAudioTracks?.()[0];
  if (!track) {
    return;
  }

  const settings = typeof track.getSettings === "function" ? track.getSettings() : null;
  const constraints = typeof track.getConstraints === "function" ? track.getConstraints() : null;
  console.log(
    JSON.stringify({
      event: "client.mic_capture_settings",
      ts: new Date().toISOString(),
      settings,
      constraints,
    }),
  );
}

async function startSession() {
  if (state.startupInFlight) {
    return;
  }

  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  state.startupInFlight = true;
  resetConversationUi();
  updateSessionControls();
  setError("");
  capturePostHog("voice_agent_call_start_clicked", {
    scenario: getSessionScenario(),
    tts_provider: getTtsConfig()?.provider ?? null,
    tts_model: getTtsConfig()?.model ?? null,
    tts_voice: getTtsConfig()?.voice ?? null,
  });

  try {
    setStatus("requesting_mic");
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    logMicCaptureSettings(state.mediaStream);
    await setupAudioTransport(state.mediaStream);

    setStatus("connecting");
    const sessionId = crypto.randomUUID();
    const sampleRate = state.audioContext?.sampleRate;
    const ttsConfig = getTtsConfig();
    const scenario = getSessionScenario();
    const analytics = syncAnalyticsIdentity();
    if (!sampleRate) {
      throw new Error("Audio context did not expose a sample rate.");
    }

    state.currentSessionId = sessionId;
    state.currentTtsConfig = ttsConfig ?? null;
    state.currentScenario = scenario;
    state.socket = await connectSessionSocket(sessionId, sampleRate, ttsConfig, scenario, analytics);
    attachDropHandlers(state.socket);
    void setupBrowserVad(state.mediaStream, state.audioContext);

    setStatus("listening");
    setError("");
    capturePostHog("voice_agent_client_call_started", buildCallAnalyticsProperties());
    updateSessionControls();
  } catch (error) {
    cleanupMedia();
    state.socket = null;
    resetCallAnalyticsState();
    setStatus("error");
    const message = mapStartupError(error);
    setError(message);
    capturePostHog("voice_agent_call_start_failed", buildCallAnalyticsProperties({ message }));
  } finally {
    state.startupInFlight = false;
    updateSessionControls();
  }
}

// ── Init ──

syncTtsOptionsToProvider();
updateSessionControls();
syncAnalyticsIdentity();
capturePostHog("voice_agent_page_viewed", {
  path: typeof window?.location?.pathname === "string" ? window.location.pathname : null,
  app_base_path: resolveAppBasePath(),
  posthog_session_id: state.analyticsSessionId,
});

// Segmented TTS model control
function updateSegIndicator() {
  updateSegmentIndicator(ttsSegmented, ttsSegIndicator);
}

if (ttsSegmented) {
  for (const btn of ttsSegmented.querySelectorAll(".seg-btn")) {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      for (const b of ttsSegmented.querySelectorAll(".seg-btn")) b.classList.remove("active");
      btn.classList.add("active");
      updateSegIndicator();
      syncTtsOptionsToProvider();
    });
  }
  // Initial indicator position
  requestAnimationFrame(updateSegIndicator);
}


// Scenario pills
if (scenarioPills) {
  for (const pill of scenarioPills.querySelectorAll(".pill")) {
    pill.addEventListener("click", () => {
      if (pill.disabled) return;
      for (const p of scenarioPills.querySelectorAll(".pill")) p.classList.remove("active");
      pill.classList.add("active");
    });
  }
}

function endSession() {
  const socket = state.socket;
  capturePostHog("voice_agent_client_call_ended", buildCallAnalyticsProperties({ reason: "client_stop" }));
  state.socket = null;

  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "session.stop" }));
  }

  cleanupMedia();
  resetCallAnalyticsState();
  ttfaTimer.reset();
  setStatus("idle");
  setError("");
  updateSessionControls();

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close(1000, "Client ended session");
  }
}

function isSessionActive() {
  return !!state.socket &&
    (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING);
}

startSessionButton.addEventListener("click", () => {
  void startSession();
});

endSessionButton.addEventListener("click", endSession);

// Orb hover + click interaction
if (orbWrap) {
  orbWrap.addEventListener("mouseenter", () => {
    if (orb) orb.setHover(true);
  });
  orbWrap.addEventListener("mouseleave", () => {
    if (orb) orb.setHover(false);
  });
  orbWrap.addEventListener("click", () => {
    if (orb) orb.pulse(0.7);
    if (state.startupInFlight) return;
    if (isSessionActive()) {
      endSession();
    } else {
      void startSession();
    }
  });
  orbWrap.addEventListener("mousedown", () => {
    if (orb) orb.pulse(0.3);
  });
}
