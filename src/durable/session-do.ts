import { DurableObject } from "cloudflare:workers";
import {
  capturePostHogEvent,
  getPostHogAppSurface,
  normalizePostHogApiHost,
  parseBooleanEnv,
} from "../analytics/posthog";
import { TurnLatencyTracker } from "../benchmark/turn-latency";
import { createDefaultProviderRuntime } from "../providers/default-runtime";
import type { GroqApiKeyRecord } from "../providers/groq-key-pool";
import { parseGroqApiKeys, rankGroqApiKeys } from "../providers/groq-key-pool";
import { generateBackgroundToolPlanWithNativeCalls, GroqRateLimitError } from "../adapters/groq";
import { generateBackgroundToolPlanWithWorkersAi } from "../adapters/workers-ai-text";
import type {
  ConversationMessage,
  ProviderRuntime,
  SpeechSynthesizerStream,
  TtsProvider,
  TurnDetectorSession,
  WorkersAiBinding,
} from "../providers/contracts";
import {
  ASSISTANT_AUDIO_CHANNELS,
  ASSISTANT_AUDIO_ENCODING,
  DEFAULT_ASSISTANT_AUDIO_SAMPLE_RATE,
  SESSION_SCENARIOS,
  type SessionScenario,
  clientMessageSchema,
  sessionErrorMessageSchema,
  sessionReadyMessageSchema,
  sessionStateMessageSchema,
  serverMessageSchema,
} from "../protocol/messages";
import { type SessionState } from "./session-state";
import {
  type BackgroundActionExecution,
  type BackgroundToolRegistry,
  executeAllowlistedActions,
  parseToolPlan,
} from "./background-tool-lane";

type SessionEnv = {
  AI?: WorkersAiBinding;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_KEY?: string;
  GROQ_API_KEY?: string;
  GROQ_API_KEYS?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  TOGETHER_API_KEY?: string;
  TOGETHER_TTS_VOICE?: string;
  TURN_DETECTOR_PROVIDER?: string;
  TTS_PROVIDER?: string;
  TEXT_GENERATOR_PROVIDER?: string;
  POSTHOG_PROJECT_API_KEY?: string;
  POSTHOG_API_HOST?: string;
  POSTHOG_CAPTURE_TRANSCRIPTS?: string;
};

type ActiveProviderWork = {
  assistantTurnId: number;
  userTurnId: number;
  userTranscript: string;
  llmAbort: AbortController;
  ttsAbort: AbortController;
  ttsStream: SpeechSynthesizerStream | null;
  latencyTracker: TurnLatencyTracker;
  latencyLogged: boolean;
  audioBytesSent: number;
  audioSampleRate: number;
  speculative: boolean;
  committed: boolean;
  userCommitted: boolean;
  assistantCommitted: boolean;
  completed: boolean;
  finalAssistantText: string | null;
  bufferedAudioChunks: Uint8Array[];
  audioStartPrepared: boolean;
  audioStartSent: boolean;
};

type PendingCompletedLatency = {
  assistantTurnId: number;
  tracker: TurnLatencyTracker;
};

type PendingCompletedTrace = {
  assistantTurnId: number;
  tracker: TurnLatencyTracker;
  audioBytesSent: number;
  audioSampleRate: number;
};

type BackgroundMessageOrigin = "user_turn" | "assistant_primary" | "assistant_followup" | "tool_result";

type BackgroundHistoryEntry = {
  role: "user" | "assistant";
  content: string;
  turnId: number;
  origin: BackgroundMessageOrigin;
};

type BackgroundTurnStatus = "pending" | "in_progress" | "completed" | "failed";

type BackgroundTurnResult = {
  turnId: number;
  status: BackgroundTurnStatus;
  actions: BackgroundActionExecution[];
  error?: string;
  updatedAt: string;
};

type BackgroundPassInput = {
  turnId: number;
  userTranscript: string;
  assistantText: string;
  origin: "assistant_primary" | "assistant_followup";
  userDriven: boolean;
};

type BackgroundPlanningMode = "groq_native_tool_calls" | "workers_ai_native_tool_calls" | "structured_json";

type DeferredFollowupIngestion = {
  turnId: number;
  content: string;
};

type BackgroundCartItem = {
  item: string;
  quantity: number;
  unitPriceGbp: number;
};

type OperationalLogFields = Record<string, unknown>;

const DEFAULT_SESSION_SCENARIO: SessionScenario = "drive-thru";
const ENABLE_VOICE_SYSTEM_PROMPT = true;
const ENABLE_LLM_PREWARM = true;
const ENABLE_BACKGROUND_TOOL_LANE = true;
const ENABLE_BACKGROUND_FOLLOWUPS = false;
const IDLE_HANGUP_TIMEOUT_MS = 10_000;
const IDLE_HANGUP_REASON = "Call ended after 10 seconds of inactivity.";
const BACKGROUND_TOOL_SYSTEM_PROMPT_STRUCTURED_BASE =
  "You are the background tool planner. Return strict JSON only: {\"actions\":[{\"tool\":\"tool_name\",\"args\":{}}]}. No markdown, no prose, no extra keys. Use only the listed tools. Only call a tool when the assistant has explicitly committed to doing something concrete for the user. Do not call tools for suggestions, recommendations, menu descriptions, clarification questions, or vague requests. If one committed request requires multiple distinct actions, emit one action per operation and do not drop any part of the request. Preserve explicit details exactly, including quantities and other confirmed fields. If the latest user message is only a confirmation, resolve it against the immediately previous assistant clarification. Use an empty actions array if no tool calls are needed.";
const BACKGROUND_TOOL_SYSTEM_PROMPT_NATIVE_BASE =
  "Return exactly one native function call named submit_actions. Put the complete action list for this turn in actions. Include all committed actions and preserve quantities and other confirmed details. If the latest user message is only a confirmation, resolve it against the immediately previous assistant clarification. If no action is needed, call submit_actions with an empty actions array. Do not write text.";
const BACKGROUND_FOLLOWUP_SYSTEM_PROMPT =
  "You are the agent. You are shown a recent user turn, your reply, and the result of what happened next.\n\nWrite [pass] if the user does not need to hear anything else.\n\nWrite a follow-on reply if the result means the user should be told something now, such as a failure, a partial success, or an important correction.\n\nDo not continue the conversation.\nDo not ask a question unless immediate clarification is required.\nDo not comment on the quality of the reply.";
// Old prompt kept for reference:
// const VOICE_AGENT_CORE_PROMPT =
//   "You are an assistant speaking in real time. Keep responses very concise and conversational for speech. Avoid markdown, lists, tables, or visual formatting. Be friendly, natural, and direct. When the conversation starts, briefly greet the user and say what you can help with. Because your replies are spoken aloud, write everything in natural spoken form rather than display form. Spell out numbers, prices, times, dates, and similar values the way a person would say them.";
// const VOICE_AGENT_ASYNC_ACTION_PROMPT_BASE =
//   "When a user asks you to do something, say what you will do. Do not claim completion unless a later message confirms it. If a user asks about a result that has not been confirmed yet, say it is still processing.";
const VOICE_AGENT_CORE_PROMPT =
  "You are a real-time spoken drive-thru assistant. Be concise, natural, friendly, and fast. Speak like a casual voice assistant (no markdown, no lists, no tables). Greet briefly when starting and state what you can help with.";
const VOICE_AGENT_ASYNC_ACTION_PROMPT_BASE =
  "Act with short confirmations for actions: I'll do that, I'm checking that now, or It is still processing when not yet confirmed complete.";
const VOICE_AGENT_SCENARIO_PROMPTS: Record<SessionScenario, string> = {
  "drive-thru":
    "The full menu is: burger £6.49 (say 6 pounds 49), fries £3.29, nuggets £4.99, soda £1.99, shake £3.99, salad £5.49. Ask follow-up if unclear; do not guess.",
  "restaurant-booking":
    "You are the front-of-house host for a popular neighborhood restaurant answering reservation calls. Sound polished, warm, and organized. Confirm details carefully, ask for missing information naturally, and make the guest feel looked after without sounding stiff. You can help by checking availability, making a reservation, updating a reservation, and canceling a reservation.",
  "customer-support":
    "You are a customer support agent at an online retail company helping someone over the phone about an order. Sound calm, capable, and reassuring. Be clear about what you are checking, avoid overpromising, and keep the customer informed while you work through the issue. You can help by checking an order, starting a return, updating a shipping address, and escalating to a human if needed.",
};
const BACKGROUND_TOOL_PROMPT_EXAMPLES: Record<SessionScenario, string> = {
  "drive-thru":
    'Example format: if the committed request is for one burger and two fries, call submit_actions with {"actions":[{"tool":"add_menu_item","args":{"item":"burger","quantity":1}},{"tool":"add_menu_item","args":{"item":"fries","quantity":2}}]}.',
  "restaurant-booking":
    'Example format: if the committed request is to book a table for four tomorrow at seven under Maya, call submit_actions with {"actions":[{"tool":"create_reservation","args":{"name":"Maya","date":"tomorrow","time":"7:00 PM","partySize":4}}]}.',
  "customer-support":
    'Example format: if the committed request is to update the shipping address for order 1001 to Boston, call submit_actions with {"actions":[{"tool":"update_shipping_address","args":{"orderId":"1001","city":"Boston"}}]}.',
};
const BACKGROUND_DRIVE_THRU_PRICE_CATALOG: Record<string, number> = {
  burger: 6.49,
  fries: 3.29,
  nuggets: 4.99,
  soda: 1.99,
  shake: 3.99,
  salad: 5.49,
};
const BACKGROUND_DRIVE_THRU_ITEM_ALIASES: Record<string, string> = {
  cheeseburger: "burger",
  hamburger: "burger",
  classic_burger: "burger",
  classic_cheeseburger: "burger",
  drink: "soda",
  soft_drink: "soda",
  coke: "soda",
  cola: "soda",
  fries_order: "fries",
  milkshake: "shake",
  vanilla_shake: "shake",
  chocolate_shake: "shake",
  strawberry_shake: "shake",
};
const BACKGROUND_SUPPORT_ORDER_FIXTURES: Record<
  string,
  {
    currency: string;
    status: string;
    totalGbp: number;
    items: string[];
  }
> = {
  "1001": { currency: "GBP", status: "preparing", totalGbp: 12.48, items: ["burger", "fries", "soda"] },
  "2002": { currency: "GBP", status: "shipped", totalGbp: 39.99, items: ["coffee maker"] },
};

function isSessionScenario(value: unknown): value is SessionScenario {
  return typeof value === "string" && SESSION_SCENARIOS.includes(value as SessionScenario);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return false;
}

function logOperationalEvent(event: string, fields: OperationalLogFields): void {
  console.log(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
}

function summarizeLatencyFields(tracker: TurnLatencyTracker) {
  const summary = tracker.summarizeLatency();

  return {
    assistantTurnId: summary.assistantTurnId,
    userTurnId: summary.userTurnId,
    turnDetector: summary.providers.turnDetector,
    textGenerator: summary.providers.textGenerator,
    speechSynthesizer: summary.providers.speechSynthesizer,
    usedSpeculativeStart: summary.usedSpeculativeStart,
    ...summary.metrics,
  };
}

function pcmAudioDurationMs(audioBytesSent: number, sampleRate: number): number {
  const bytesPerMs = Math.max(1, (sampleRate * 2) / 1000);
  return Math.max(0, Math.round(audioBytesSent / bytesPerMs));
}

function summarizeTraceFields(tracker: TurnLatencyTracker, audioBytesSent: number, audioSampleRate: number) {
  const summary = tracker.summarizeTrace(pcmAudioDurationMs(audioBytesSent, audioSampleRate));
  const marksTsMs = tracker.getMarks();
  const marksFromEndOfTurnMs = tracker.getMarksRelativeTo("endOfTurn");

  return {
    assistantTurnId: summary.assistantTurnId,
    userTurnId: summary.userTurnId,
    turnDetector: summary.providers.turnDetector,
    textGenerator: summary.providers.textGenerator,
    speechSynthesizer: summary.providers.speechSynthesizer,
    usedSpeculativeStart: summary.usedSpeculativeStart,
    audioSampleRate,
    marksTsMs,
    marksFromEndOfTurnMs,
    ...summary.metrics,
  };
}

function splitReadySpeechClauses(text: string): { readyClauses: string[]; remainder: string } {
  const readyClauses: string[] = [];
  let remainder = text;

  while (remainder.length > 0) {
    const punctuationMatch = remainder.match(/^[\s\S]*?[.!?;:,](?:\s+|$)/);
    if (punctuationMatch?.[0]) {
      readyClauses.push(punctuationMatch[0]);
      remainder = remainder.slice(punctuationMatch[0].length);
      continue;
    }

    if (remainder.length >= 80) {
      const splitAt = remainder.lastIndexOf(" ", 80);
      if (splitAt > 20) {
        readyClauses.push(remainder.slice(0, splitAt + 1));
        remainder = remainder.slice(splitAt + 1);
        continue;
      }
    }

    break;
  }

  return { readyClauses, remainder };
}

function buildBackgroundToolSystemPrompt(
  toolNames: string[],
  mode: BackgroundPlanningMode,
  scenario: SessionScenario,
): string {
  const listedTools = toolNames.length > 0 ? toolNames.join(", ") : "(none)";
  const example = BACKGROUND_TOOL_PROMPT_EXAMPLES[scenario] ?? BACKGROUND_TOOL_PROMPT_EXAMPLES["drive-thru"];
  if (mode === "groq_native_tool_calls" || mode === "workers_ai_native_tool_calls") {
    return `${BACKGROUND_TOOL_SYSTEM_PROMPT_NATIVE_BASE} Available tools: ${listedTools}. ${example}`;
  }

  return `${BACKGROUND_TOOL_SYSTEM_PROMPT_STRUCTURED_BASE} Available tools: ${listedTools}. ${example}`;
}

function serializeForHiddenNote(value: unknown, maxChars = 220): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  if (serialized.length <= maxChars) {
    return serialized;
  }

  return `${serialized.slice(0, maxChars - 3)}...`;
}

function buildPromptHistory(
  conversationHistory: ConversationMessage[],
  transcript: string,
  userCommitted: boolean,
  hiddenResultNotes: string[] = [],
  systemPrompt?: string,
): ConversationMessage[] {
  const messages = userCommitted
    ? [...conversationHistory]
    : [...conversationHistory, { role: "user", content: transcript } as ConversationMessage];
  const hiddenMessages = hiddenResultNotes.map(
    (note) =>
      ({
        role: "system",
        content: note,
      }) as ConversationMessage,
  );
  const withHiddenNotes =
    hiddenMessages.length === 0
      ? messages
      : userCommitted
        ? [...messages, ...hiddenMessages]
        : [...messages.slice(0, -1), ...hiddenMessages, messages[messages.length - 1] as ConversationMessage];

  if (!ENABLE_VOICE_SYSTEM_PROMPT || !systemPrompt) {
    return withHiddenNotes;
  }

  return [{ role: "system", content: systemPrompt }, ...withHiddenNotes];
}

export class SessionDO extends DurableObject<SessionEnv> {
  private state: SessionState = "idle";
  private activeSocket: WebSocket | null = null;
  private activeSessionId: string | null = null;
  private lastAcceptedAudioChunkSequence: number | null = null;
  private clientSampleRate = DEFAULT_ASSISTANT_AUDIO_SAMPLE_RATE;
  private audioNegotiated = false;
  private conversationHistory: ConversationMessage[] = [];
  private nextUserTurnId = 1;
  private activeAssistantTurnId = 0;
  private invalidatedAssistantTurnIds = new Set<number>();
  private activeProviderWork: ActiveProviderWork | null = null;
  private pendingCompletedLatency: PendingCompletedLatency | null = null;
  private pendingCompletedTrace: PendingCompletedTrace | null = null;
  private providerRuntime: ProviderRuntime | null = null;
  private turnDetectorSession: TurnDetectorSession | null = null;
  private turnDetectorConnectPromise: Promise<void> | null = null;
  private sessionScenario: SessionScenario = DEFAULT_SESSION_SCENARIO;
  private sessionTtsProviderOverride: TtsProvider | null = null;
  private sessionTtsModelOverride: string | null = null;
  private sessionTtsVoiceOverride: string | null = null;
  private demoSystemPromptOverride: string | null = null;
  private demoDisabledTools: string[] = [];
  private groqRankedApiKeys: GroqApiKeyRecord[] | null = null;
  private groqPinnedApiKeyIndex = 0;
  private groqKeySessionId: string | null = null;
  private backgroundQueue: Promise<void> = Promise.resolve();
  private backgroundHistory: BackgroundHistoryEntry[] = [];
  private backgroundTurnResults = new Map<number, BackgroundTurnResult>();
  private backgroundToolRegistryOverride: BackgroundToolRegistry | null = null;
  private deferredFollowupIngestion: DeferredFollowupIngestion[] = [];
  private nextFollowupAssistantTurnId = 1_000_000;
  private backgroundCartItems = new Map<string, BackgroundCartItem>();
  private idleHangupTimer: ReturnType<typeof setTimeout> | null = null;
  private userTurnActive = false;
  private assistantPlaybackActive = false;
  private analyticsDistinctId: string | null = null;
  private analyticsSessionId: string | null = null;

  async fetch(request: Request): Promise<Response> {
    this.ensureRuntimeState();

    const url = new URL(request.url);
    if (url.pathname !== "/api/session") {
      return new Response("Not Found", { status: 404 });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (this.activeSocket && this.activeSocket !== server) {
      this.clearActiveConnection(this.activeSocket, "replaced_connection");
    }

    this.activeSocket = server;
    this.activeSessionId = sessionId;
    this.ctx.acceptWebSocket(server);
    logOperationalEvent("session.connected", { sessionId });

    this.sendServerMessage(server, sessionReadyMessageSchema.parse({ type: "session.ready", sessionId }));
    this.transitionState("connecting");

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.ensureRuntimeState();

    if (message instanceof ArrayBuffer) {
      if (ws !== this.activeSocket) {
        return;
      }
      if (!this.audioNegotiated) {
        this.sendServerMessage(
          ws,
          sessionErrorMessageSchema.parse({
            type: "session.error",
            code: "AUDIO_NOT_NEGOTIATED",
            message: "Audio transport must be negotiated before sending binary frames.",
          }),
        );
        return;
      }

      this.lastAcceptedAudioChunkSequence = (this.lastAcceptedAudioChunkSequence ?? -1) + 1;
      void this.forwardAudioChunk(new Uint8Array(message));
      return;
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(message);
    } catch {
      this.sendInvalidMessage(ws);
      return;
    }

    if (!parsedPayload || typeof parsedPayload !== "object" || !("type" in parsedPayload)) {
      this.sendInvalidMessage(ws);
      return;
    }

    const parsedMessage = clientMessageSchema.safeParse(parsedPayload);
    if (!parsedMessage.success) {
      this.sendInvalidMessage(ws);
      return;
    }

    switch (parsedMessage.data.type) {
      case "session.start":
        if (ws === this.activeSocket) {
          this.resetConversationStateForNewCall();
          this.clientSampleRate = parsedMessage.data.sampleRate;
          this.analyticsDistinctId = parsedMessage.data.analytics?.distinctId ?? null;
          this.analyticsSessionId = parsedMessage.data.analytics?.sessionId ?? null;
          this.sessionScenario = parsedMessage.data.scenario ?? DEFAULT_SESSION_SCENARIO;
          const nextTtsProviderOverride = parsedMessage.data.ttsConfig?.provider ?? null;
          const nextTtsModelOverride = parsedMessage.data.ttsConfig?.model ?? null;
          const nextTtsVoiceOverride = parsedMessage.data.ttsConfig?.voice ?? null;
          const ttsConfigChanged =
            this.sessionTtsProviderOverride !== nextTtsProviderOverride ||
            this.sessionTtsModelOverride !== nextTtsModelOverride ||
            this.sessionTtsVoiceOverride !== nextTtsVoiceOverride;
          this.sessionTtsProviderOverride = nextTtsProviderOverride;
          this.sessionTtsModelOverride = nextTtsModelOverride;
          this.sessionTtsVoiceOverride = nextTtsVoiceOverride;
          this.demoSystemPromptOverride = parsedMessage.data.demoOverrides?.systemPrompt ?? null;
          this.demoDisabledTools = parsedMessage.data.demoOverrides?.disabledTools ?? [];
          if (ttsConfigChanged) {
            this.providerRuntime?.dispose?.();
            this.providerRuntime = null;
          }
          logOperationalEvent("session.start.received", {
            sessionId: this.activeSessionId,
            scenario: this.sessionScenario,
          });
          this.captureAnalyticsEvent("voice_agent_call_started", {
            client_sample_rate: this.clientSampleRate,
            turn_detector_provider: this.getProviderRuntime().labels.turnDetector,
            text_generator_provider: this.getProviderRuntime().labels.textGenerator,
            speech_synthesizer_provider: this.getProviderRuntime().labels.speechSynthesizer,
          });
          this.audioNegotiated = true;
          this.transitionState("connecting");
          void this.prepareSessionForListening();
        }
        break;
      case "client.interrupt":
        if (ws === this.activeSocket) {
          this.cancelActiveAssistantTurn("client_hint");
        }
        break;
      case "turn.assistant.playback.started":
        if (ws === this.activeSocket) {
          this.handleAssistantPlaybackStarted(parsedMessage.data.assistantTurnId, parsedMessage.data.clientTsMs);
        }
        break;
      case "turn.assistant.playback.ended":
        if (ws === this.activeSocket) {
          this.handleAssistantPlaybackEnded(parsedMessage.data.assistantTurnId, parsedMessage.data.clientTsMs);
        }
        break;
      case "turn.assistant.audio.start.received":
        if (ws === this.activeSocket) {
          this.logCriticalPathEvent("server.audio_start_received", {
            assistantTurnId: parsedMessage.data.assistantTurnId,
            clientTsMs: parsedMessage.data.clientTsMs ?? null,
          });
        }
        break;
      case "session.stop":
        this.clearActiveConnection(ws, "client_stop");
        break;
      default:
        break;
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    const details = error instanceof Error ? error.message : "WebSocket connection failed.";
    logOperationalEvent("session.websocket.error", {
      sessionId: this.activeSessionId,
      message: details,
    });

    this.sendServerMessage(
      ws,
      sessionErrorMessageSchema.parse({
        type: "session.error",
        code: "WS_CONNECT_FAILED",
        message: details,
      }),
    );
    this.clearActiveConnection(ws, "ws_error");
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    if (this.activeSocket !== ws) {
      return;
    }

    logOperationalEvent("session.websocket.closed", {
      sessionId: this.activeSessionId,
      reason: reason || "Socket closed",
    });

    this.sendServerMessage(
      ws,
      sessionErrorMessageSchema.parse({
        type: "session.error",
        code: "WS_DROPPED",
        message: "WebSocket connection dropped.",
      }),
    );
    this.sendServerMessage(ws, {
      type: "session.closed",
      reason: reason || "Socket closed",
    });
    try {
      ws.close(code, reason);
    } catch {
      // Ignore close races.
    }
    this.clearActiveConnection(ws, reason || "ws_closed");
  }

  private logCriticalPathEvent(
    event: string,
    fields: OperationalLogFields = {},
    work: ActiveProviderWork | null = null,
  ): void {
    const labels = work
      ? work.latencyTracker.summarizeLatency().providers
      : this.providerRuntime?.labels;
    const groqKeyLabel = labels?.textGenerator === "groq" ? this.getSelectedGroqApiKeyLabel() : null;

    logOperationalEvent(event, {
      sessionId: this.activeSessionId,
      assistantTurnId: work?.assistantTurnId,
      userTurnId: work?.userTurnId,
      turnDetector: labels?.turnDetector,
      textGenerator: labels?.textGenerator,
      speechSynthesizer: labels?.speechSynthesizer,
      groqKeyLabel,
      ...fields,
    });
  }

  handleStartOfTurn(transcriptHint?: string): void {
    this.ensureRuntimeState();
    this.userTurnActive = true;
    this.syncIdleHangupTimer();
    logOperationalEvent("turn.user.start", {
      sessionId: this.activeSessionId,
      state: this.state,
    });
    this.logCriticalPathEvent("server.turn_detector_start_of_turn", {
      transcriptHint: transcriptHint ?? null,
    });

    if (this.activeProviderWork && !this.activeProviderWork.committed) {
      this.cancelActiveAssistantTurn("start_of_turn");
      return;
    }

    if (this.state === "thinking" || this.state === "speaking") {
      this.cancelActiveAssistantTurn("start_of_turn");
      return;
    }

    if (this.state !== "listening") {
      this.transitionState("listening");
    }
  }

  handleEagerEndOfTurn(finalTranscript: string): void {
    this.ensureRuntimeState();

    const transcript = finalTranscript.trim();
    if (!transcript || this.state !== "listening") {
      return;
    }

    this.logCriticalPathEvent("server.turn_detector_eager_eot", {
      transcriptText: transcript,
    });

    if (this.activeProviderWork?.speculative && !this.activeProviderWork.committed) {
      if (this.activeProviderWork.userTranscript === transcript) {
        return;
      }
      return;
    }

    const userTurnId = this.nextUserTurnId;
    this.nextUserTurnId += 1;
    void this.startAssistantTurn(userTurnId, transcript, true);
  }

  handleTurnResumed(): void {
    this.ensureRuntimeState();
    this.userTurnActive = true;
    this.syncIdleHangupTimer();

    if (this.activeProviderWork?.speculative && !this.activeProviderWork.committed) {
      this.logCriticalPathEvent(
        "server.speculative_canceled",
        {
          reason: "turn_resumed",
          eagerTranscriptText: this.activeProviderWork.userTranscript,
        },
        this.activeProviderWork,
      );
      this.cancelActiveAssistantTurn("turn_resumed");
    }
  }

  async handleEndOfTurn(finalTranscript: string): Promise<void> {
    this.ensureRuntimeState();
    this.userTurnActive = false;

    const transcript = finalTranscript.trim();
    if (!transcript) {
      return;
    }

    this.logCriticalPathEvent("server.turn_detector_final_eot", {
      transcriptText: transcript,
    });

    if (this.activeProviderWork?.speculative && !this.activeProviderWork.committed) {
      if (this.activeProviderWork.userTranscript === transcript) {
        this.commitAssistantTurn(this.activeProviderWork);
        return;
      }

      this.logCriticalPathEvent(
        "server.speculative_canceled",
        {
          reason: "transcript_mismatch",
          eagerTranscriptText: this.activeProviderWork.userTranscript,
          finalTranscriptText: transcript,
        },
        this.activeProviderWork,
      );
      this.cancelActiveAssistantTurn("turn_resumed");
    }

    const userTurnId = this.nextUserTurnId;
    this.nextUserTurnId += 1;
    await this.startAssistantTurn(userTurnId, transcript, false);
  }

  private async startAssistantTurn(userTurnId: number, transcript: string, speculative: boolean): Promise<void> {
    const assistantTurnId = this.activeAssistantTurnId + 1;
    this.activeAssistantTurnId = assistantTurnId;
    this.invalidatedAssistantTurnIds.delete(assistantTurnId);
    this.pendingCompletedLatency = null;
    this.pendingCompletedTrace = null;
    logOperationalEvent("assistant.turn.started", {
      sessionId: this.activeSessionId,
      assistantTurnId,
      userTurnId,
      speculative,
      groqKeyLabel: this.getSelectedGroqApiKeyLabel(),
    });

    const llmAbort = new AbortController();
    const ttsAbort = new AbortController();
    const providerRuntime = this.getProviderRuntime();
    const latencyTracker = new TurnLatencyTracker(assistantTurnId, userTurnId, providerRuntime.labels);

    const work: ActiveProviderWork = {
      assistantTurnId,
      userTurnId,
      userTranscript: transcript,
      llmAbort,
      ttsAbort,
      ttsStream: null,
      latencyTracker,
      latencyLogged: false,
      audioBytesSent: 0,
      audioSampleRate: providerRuntime.speechSynthesizer.sampleRate,
      speculative,
      committed: false,
      userCommitted: false,
      assistantCommitted: false,
      completed: false,
      finalAssistantText: null,
      bufferedAudioChunks: [],
      audioStartPrepared: false,
      audioStartSent: false,
    };
    if (speculative) {
      latencyTracker.mark("eagerEndOfTurn");
    }
    this.activeProviderWork = work;
    this.logCriticalPathEvent(
      "server.assistant_turn_started",
      {
        speculative,
        transcriptText: transcript,
      },
      work,
    );

    if (!speculative) {
      this.commitAssistantTurn(work);
    }

    let pendingSpeech = "";
    let assistantText = "";
    const promptHistory = buildPromptHistory(
      this.conversationHistory,
      transcript,
      work.userCommitted,
      this.buildHiddenResultNotes(),
      this.getVoiceAgentSystemPrompt(),
    );

    const ensureTtsStream = async (): Promise<SpeechSynthesizerStream> => {
      const currentWork = this.activeProviderWork;
      if (currentWork?.assistantTurnId !== assistantTurnId) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (currentWork.ttsStream) {
        return currentWork.ttsStream;
      }

      const ttsStream = providerRuntime.speechSynthesizer.createStream({
        onAudioChunk: (chunk: Uint8Array) => {
          if (!this.isAssistantTurnCurrent(assistantTurnId)) {
            return;
          }

          const latestWork = this.activeProviderWork;
          if (!latestWork || latestWork.assistantTurnId !== assistantTurnId) {
            return;
          }

          latestWork.audioBytesSent += chunk.byteLength;
          if (!latestWork.audioStartPrepared) {
            latestWork.audioStartPrepared = true;
            latencyTracker.mark("firstAudioGenerated");
            this.logCriticalPathEvent("server.tts_first_audio_generated", {}, latestWork);
            this.sendPartialTrace(latencyTracker, latestWork.assistantTurnId);
          }

          if (!latestWork.committed) {
            latestWork.bufferedAudioChunks.push(new Uint8Array(chunk));
            return;
          }

          this.emitBufferedAssistantAudio(latestWork, [new Uint8Array(chunk)]);
        },
        onError: (error: Error) => {
          this.handlePipelineError(error);
        },
      });

      ttsAbort.signal.addEventListener(
        "abort",
        () => {
          ttsStream.close(true);
        },
        { once: true },
      );

      await ttsStream.connect();
      latencyTracker.mark("ttsReady");
      currentWork.ttsStream = ttsStream;
      return ttsStream;
    };

    const sendTextToTts = async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const ttsStream = await ensureTtsStream();
      if (!latencyTracker.hasMark("firstChunkSentToTts")) {
        latencyTracker.mark("firstChunkSentToTts");
        this.logCriticalPathEvent("server.tts_first_text_sent", {}, work);
      }
      ttsStream.sendText(trimmed);
    };

    const runAssistantPipeline = async (): Promise<void> => {
      const currentProviderRuntime = this.getProviderRuntime();
      if (!latencyTracker.hasMark("llmRequestStarted")) {
        latencyTracker.mark("llmRequestStarted");
        this.logCriticalPathEvent("server.llm_request_started", {}, work);
      }
      for await (const delta of currentProviderRuntime.textGenerator.streamText(promptHistory, llmAbort.signal, (usage) => {
        logOperationalEvent("llm.usage", {
          sessionId: this.activeSessionId,
          assistantTurnId,
          userTurnId,
          model: currentProviderRuntime.labels.textGenerator,
          groqKeyLabel: currentProviderRuntime.labels.textGenerator === "groq" ? this.getSelectedGroqApiKeyLabel() : null,
          promptTokens: usage.promptTokens ?? null,
          completionTokens: usage.completionTokens ?? null,
          totalTokens: usage.totalTokens ?? null,
          cachedTokens: usage.cachedTokens ?? null,
          queueTime: usage.queueTime ?? null,
          promptTime: usage.promptTime ?? null,
          completionTime: usage.completionTime ?? null,
          totalTime: usage.totalTime ?? null,
        });
      })) {
        if (!this.isAssistantTurnCurrent(assistantTurnId)) {
          return;
        }

        if (!latencyTracker.hasMark("firstText")) {
          latencyTracker.mark("firstText");
          this.logCriticalPathEvent("server.llm_first_token", {}, work);
          this.sendPartialTrace(latencyTracker, work.assistantTurnId);
        }
        assistantText += delta;
        pendingSpeech += delta;

        const { readyClauses, remainder } = splitReadySpeechClauses(pendingSpeech);
        pendingSpeech = remainder;

        for (const clause of readyClauses) {
          await sendTextToTts(clause);
        }
      }
      latencyTracker.mark("llmDone");
      this.logCriticalPathEvent("server.llm_done", {}, work);

      const finalAssistantText = assistantText.trim();
      if (!finalAssistantText) {
        throw new Error("Groq response did not include assistant text.");
      }

      work.finalAssistantText = finalAssistantText;
      logOperationalEvent("assistant.turn.generated", {
        sessionId: this.activeSessionId,
        assistantTurnId,
        textLength: finalAssistantText.length,
      });
      this.maybeEmitAssistantFinal(work);

      if (pendingSpeech.trim().length > 0) {
        await sendTextToTts(pendingSpeech);
      }

      const ttsStream = await ensureTtsStream();
      await ttsStream.flush();
      latencyTracker.mark("ttsDone");

      if (!this.isAssistantTurnCurrent(assistantTurnId)) {
        return;
      }

      work.completed = true;
      if (work.committed) {
        this.finishCommittedAssistantTurn(work);
      }
    };

    try {
      await runAssistantPipeline();
    } catch (error) {
      if (isAbortError(error)) {
        logOperationalEvent("assistant.turn.aborted", {
          sessionId: this.activeSessionId,
          assistantTurnId,
          speculative,
        });
        return;
      }

      if (
        error instanceof GroqRateLimitError &&
        !latencyTracker.hasMark("firstText") &&
        this.advancePinnedGroqApiKey()
      ) {
        assistantText = "";
        pendingSpeech = "";
        try {
          await runAssistantPipeline();
        } catch (retryError) {
          if (isAbortError(retryError)) {
            logOperationalEvent("assistant.turn.aborted", {
              sessionId: this.activeSessionId,
              assistantTurnId,
              speculative,
            });
            return;
          }
          this.handlePipelineError(retryError);
        }
        return;
      }

      this.handlePipelineError(error);
    } finally {
      const currentWork = this.activeProviderWork;
      if (
        currentWork?.assistantTurnId === assistantTurnId &&
        !this.invalidatedAssistantTurnIds.has(assistantTurnId) &&
        currentWork.completed &&
        currentWork.committed
      ) {
        currentWork.ttsStream?.close();
        this.activeProviderWork = null;
        if (this.state === "thinking" || this.state === "speaking") {
          this.transitionState("listening");
        }
      }
    }
  }

  private commitAssistantTurn(work: ActiveProviderWork): void {
    if (!this.isAssistantTurnCurrent(work.assistantTurnId) || work.committed) {
      return;
    }

    work.committed = true;
    if (!work.latencyTracker.hasMark("endOfTurn")) {
      work.latencyTracker.mark("endOfTurn");
    }
    this.sendPartialTrace(work.latencyTracker, work.assistantTurnId);
    this.logCriticalPathEvent(
      "server.assistant_turn_committed",
      {
        transcriptText: work.userTranscript,
        speculative: work.speculative,
      },
      work,
    );

    if (!work.userCommitted) {
      logOperationalEvent("turn.user.finalized", {
        sessionId: this.activeSessionId,
        userTurnId: work.userTurnId,
        transcriptLength: work.userTranscript.length,
      });
      this.captureAnalyticsEvent("voice_agent_user_turn_final", {
        turn_id: work.userTurnId,
        transcript_length: work.userTranscript.length,
        ...(this.shouldCaptureTranscriptAnalytics() ? { text: work.userTranscript } : {}),
      });
      this.conversationHistory.push({ role: "user", content: work.userTranscript });
      this.sendToActiveSocket({
        type: "turn.user.final",
        turnId: work.userTurnId,
        text: work.userTranscript,
      });
      work.userCommitted = true;
    }

    this.maybeEmitAssistantFinal(work);

    if (work.audioStartPrepared) {
      this.emitBufferedAssistantAudio(work);
    } else if (!work.completed && this.state !== "thinking") {
      this.transitionState("thinking");
    }

    if (work.completed) {
      this.finishCommittedAssistantTurn(work);
    }
  }

  private maybeEmitAssistantFinal(work: ActiveProviderWork): void {
    if (!work.committed || work.assistantCommitted || !work.finalAssistantText) {
      return;
    }

    this.captureAnalyticsEvent("voice_agent_assistant_turn_final", {
      assistant_turn_id: work.assistantTurnId,
      turn_id: work.userTurnId,
      text_length: work.finalAssistantText.length,
      ...(this.shouldCaptureTranscriptAnalytics() ? { text: work.finalAssistantText } : {}),
    });
    this.conversationHistory.push({ role: "assistant", content: work.finalAssistantText });
    this.sendToActiveSocket({
      type: "turn.assistant.final",
      assistantTurnId: work.assistantTurnId,
      text: work.finalAssistantText,
    });
    work.assistantCommitted = true;

    if (ENABLE_BACKGROUND_TOOL_LANE) {
      this.enqueueBackgroundPass({
        turnId: work.userTurnId,
        userTranscript: work.userTranscript,
        assistantText: work.finalAssistantText,
        origin: "assistant_primary",
        userDriven: true,
      });
    }
  }

  private emitBufferedAssistantAudio(work: ActiveProviderWork, immediateChunks: Uint8Array[] = []): void {
    if (!work.audioStartPrepared || !work.committed) {
      return;
    }

    if (!work.audioStartSent) {
      this.sendToActiveSocket({
        type: "turn.assistant.audio.start",
        assistantTurnId: work.assistantTurnId,
        sampleRate: work.audioSampleRate,
        encoding: ASSISTANT_AUDIO_ENCODING,
        channels: ASSISTANT_AUDIO_CHANNELS,
      });
      work.audioStartSent = true;
      this.assistantPlaybackActive = true;
      work.latencyTracker.mark("audioStartSent");
      this.logCriticalPathEvent("server.audio_start_sent", {}, work);
      this.transitionState("speaking");
    }

    const buffered = work.bufferedAudioChunks;
    work.bufferedAudioChunks = [];
    for (const chunk of [...buffered, ...immediateChunks]) {
      if (!work.latencyTracker.hasMark("firstAudioChunkSent")) {
        work.latencyTracker.mark("firstAudioChunkSent");
        this.logCriticalPathEvent("server.first_audio_chunk_sent", {}, work);
      }
      this.sendBinaryToActiveSocket(chunk);
    }
  }

  private finishCommittedAssistantTurn(work: ActiveProviderWork): void {
    if (!this.isAssistantTurnCurrent(work.assistantTurnId) || !work.committed || !work.completed) {
      return;
    }

    if (work.audioStartPrepared && !work.audioStartSent) {
      this.emitBufferedAssistantAudio(work);
    }

    if (work.audioStartSent) {
      this.sendToActiveSocket({
        type: "turn.assistant.audio.end",
        assistantTurnId: work.assistantTurnId,
        isFinal: true,
      });
    }

    logOperationalEvent("assistant.turn.completed", {
      sessionId: this.activeSessionId,
      assistantTurnId: work.assistantTurnId,
    });
    if (work.latencyTracker.hasMark("playbackStart")) {
      work.latencyLogged = true;
      this.logTurnTrace(work.latencyTracker, work.audioBytesSent, work.audioSampleRate);
      this.pendingCompletedTrace = null;
    } else {
      this.pendingCompletedLatency = {
        assistantTurnId: work.assistantTurnId,
        tracker: work.latencyTracker,
      };
      this.pendingCompletedTrace = {
        assistantTurnId: work.assistantTurnId,
        tracker: work.latencyTracker,
        audioBytesSent: work.audioBytesSent,
        audioSampleRate: work.audioSampleRate,
      };
    }

    work.ttsStream?.close();
    if (this.activeProviderWork?.assistantTurnId === work.assistantTurnId) {
      this.activeProviderWork = null;
    }
    if (this.state === "thinking" || this.state === "speaking") {
      this.transitionState("listening");
    }
  }

  private updateBackgroundTurnResult(
    turnId: number,
    status: BackgroundTurnStatus,
    actions: BackgroundActionExecution[] = [],
    error?: string,
  ): void {
    const nextResult = {
      turnId,
      status,
      actions,
      error,
      updatedAt: new Date().toISOString(),
    };
    this.backgroundTurnResults.set(turnId, nextResult);
    if (status === "completed" || status === "failed") {
      this.captureAnalyticsEvent("voice_agent_background_turn_updated", {
        turn_id: turnId,
        status,
        action_count: actions.length,
        failed_action_count: actions.filter((action) => !action.ok).length,
        actions: actions.map((action) => ({
          tool: action.tool,
          ok: action.ok,
          ...(action.ok ? {} : { error: action.error }),
        })),
        ...(error ? { error } : {}),
      });
    }
    this.sendToActiveSocket({
      type: "background.turn.update",
      turnId,
      status,
      summary: this.formatBackgroundTurnSummary(turnId, status, actions, error),
      updatedAt: nextResult.updatedAt,
      ...(status === "completed" && actions.length > 0
        ? {
          actions: actions.map((a) => ({
            tool: a.tool,
            ok: a.ok,
            ...(a.ok ? { output: a.output } : { error: a.error }),
          })),
        }
        : {}),
    });
  }

  private appendBackgroundHistoryEntry(entry: BackgroundHistoryEntry): void {
    this.backgroundHistory.push(entry);
  }

  private renderBackgroundActionSummary(action: BackgroundActionExecution): string {
    if (action.ok) {
      return `${action.tool}=ok ${serializeForHiddenNote(action.output)}`;
    }

    return `${action.tool}=error ${action.error}`;
  }

  private renderBackgroundResultForHistory(turnId: number, actions: BackgroundActionExecution[]): string {
    if (actions.length === 0) {
      return `[turn ${turnId} result] completed: no actions`;
    }

    return `[turn ${turnId} result] completed: ${actions.map((action) => this.renderBackgroundActionSummary(action)).join("; ")}`;
  }

  private formatBackgroundTurnSummary(
    turnId: number,
    status: BackgroundTurnStatus,
    actions: BackgroundActionExecution[],
    error?: string,
  ): string {
    if (status === "pending") {
      return `turn ${turnId}: queued`;
    }

    if (status === "in_progress") {
      return `turn ${turnId}: running`;
    }

    if (status === "failed") {
      return `turn ${turnId}: failed${error ? ` (${error})` : ""}`;
    }

    if (actions.length === 0) {
      return `turn ${turnId}: completed (no actions)`;
    }

    const actionSummary = actions
      .map((action) => (action.ok ? `${action.tool}=ok` : `${action.tool}=error`))
      .join(", ");
    return `turn ${turnId}: completed (${actionSummary})`;
  }

  private buildHiddenResultNotes(): string[] {
    const sortedTurnIds = Array.from(this.backgroundTurnResults.keys()).sort((left, right) => left - right);
    const notes: string[] = [];

    for (const turnId of sortedTurnIds) {
      const result = this.backgroundTurnResults.get(turnId);
      if (!result) {
        continue;
      }

      if (result.status === "pending" || result.status === "in_progress") {
        notes.push(`[turn ${turnId} result] ${result.status}`);
        continue;
      }

      if (result.status === "failed") {
        notes.push(`[turn ${turnId} result] failed: ${result.error ?? "background processing failed"}`);
        continue;
      }

      notes.push(this.renderBackgroundResultForHistory(turnId, result.actions));
    }

    return notes;
  }

  private getVoiceAgentSystemPrompt(): string {
    if (this.demoSystemPromptOverride) {
      return this.demoSystemPromptOverride;
    }
    const scenarioPrompt = VOICE_AGENT_SCENARIO_PROMPTS[this.sessionScenario] ?? VOICE_AGENT_SCENARIO_PROMPTS["drive-thru"];
    return `${VOICE_AGENT_CORE_PROMPT}\n\n${VOICE_AGENT_ASYNC_ACTION_PROMPT_BASE}\n\n${scenarioPrompt}`;
  }

  private normalizeCurrency(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private normalizeCartItemKey(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeDriveThruItem(item: string): string {
    return BACKGROUND_DRIVE_THRU_ITEM_ALIASES[item] ?? item;
  }

  private resolveCartItemFromArgs(args: Record<string, unknown>): string {
    const candidate = args.item ?? args.item_name ?? args.name ?? args.sku;
    const normalizedItem = this.normalizeCartItemKey(candidate);
    const item =
      normalizedItem && this.sessionScenario === "drive-thru"
        ? this.normalizeDriveThruItem(normalizedItem)
        : normalizedItem;
    if (!item) {
      throw new Error("Missing item name.");
    }

    return item;
  }

  private resolveQuantityFromArgs(args: Record<string, unknown>): number {
    const candidate = args.quantity ?? args.qty ?? 1;
    const quantity = typeof candidate === "number" ? candidate : Number(candidate);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("Quantity must be greater than zero.");
    }

    return Math.round(quantity);
  }

  private buildCartSnapshot() {
    const items = Array.from(this.backgroundCartItems.values())
      .sort((left, right) => left.item.localeCompare(right.item))
      .map((entry) => ({
        item: entry.item,
        quantity: entry.quantity,
        unitPriceGbp: entry.unitPriceGbp,
        lineTotalGbp: this.normalizeCurrency(entry.unitPriceGbp * entry.quantity),
      }));
    const subtotalGbp = this.normalizeCurrency(items.reduce((sum, entry) => sum + entry.lineTotalGbp, 0));
    const itemCount = items.reduce((sum, entry) => sum + entry.quantity, 0);
    return {
      currency: "GBP",
      subtotalGbp,
      itemCount,
      items,
    };
  }

  private buildDriveThruSnapshot() {
    const snapshot = this.buildCartSnapshot();
    return {
      currency: snapshot.currency,
      totalGbp: snapshot.subtotalGbp,
      itemCount: snapshot.itemCount,
      items: snapshot.items,
    };
  }

  private getBackgroundToolRegistry(): BackgroundToolRegistry {
    if (this.backgroundToolRegistryOverride) {
      return this.backgroundToolRegistryOverride;
    }

    if (this.sessionScenario === "drive-thru") {
      return {
        add_menu_item: async (args) => {
          const item = this.resolveCartItemFromArgs(args);
          const unitPriceGbp = BACKGROUND_DRIVE_THRU_PRICE_CATALOG[item];
          if (typeof unitPriceGbp !== "number") {
            throw new Error(`Unknown drive-thru menu item: ${item}`);
          }

          const quantityAdded = this.resolveQuantityFromArgs(args);
          const previous = this.backgroundCartItems.get(item);
          const nextQuantity = (previous?.quantity ?? 0) + quantityAdded;
          this.backgroundCartItems.set(item, {
            item,
            quantity: nextQuantity,
            unitPriceGbp,
          });

          const order = this.buildDriveThruSnapshot();
          return {
            item,
            quantityAdded,
            unitPriceGbp,
            lineTotalGbp: this.normalizeCurrency(unitPriceGbp * quantityAdded),
            orderTotalGbp: order.totalGbp,
            orderItemCount: order.itemCount,
          };
        },
        remove_menu_item: async (args) => {
          const item = this.resolveCartItemFromArgs(args);
          const existing = this.backgroundCartItems.get(item);
          if (!existing) {
            throw new Error(`Menu item not in order: ${item}`);
          }

          const quantityRemoved = this.resolveQuantityFromArgs(args);
          const remaining = existing.quantity - quantityRemoved;
          if (remaining > 0) {
            this.backgroundCartItems.set(item, {
              ...existing,
              quantity: remaining,
            });
          } else {
            this.backgroundCartItems.delete(item);
          }

          const order = this.buildDriveThruSnapshot();
          return {
            item,
            quantityRemoved,
            orderTotalGbp: order.totalGbp,
            orderItemCount: order.itemCount,
          };
        },
        get_order_total: async () => this.buildDriveThruSnapshot(),
        submit_order: async () => {
          const order = this.buildDriveThruSnapshot();
          if (order.itemCount === 0) {
            return {
              submitted: false,
              emptyOrder: true,
              totalGbp: 0,
              itemCount: 0,
            };
          }

          const orderId = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
          this.backgroundCartItems.clear();
          return {
            orderId,
            totalGbp: order.totalGbp,
            itemCount: order.itemCount,
            estimatedReadyMinutes: 6,
          };
        },
      };
    }

    if (this.sessionScenario === "restaurant-booking") {
      return {
        check_availability: async (args) => {
          const date = typeof args.date === "string" ? args.date : "tonight";
          const partySize = Number(args.partySize ?? args.party_size ?? 2);
          return {
            date,
            partySize,
            availableSlots: ["6:30 PM", "7:15 PM", "8:00 PM"],
          };
        },
        create_reservation: async (args) => {
          const name = typeof args.name === "string" ? args.name : "Guest";
          const date = typeof args.date === "string" ? args.date : "tonight";
          const time = typeof args.time === "string" ? args.time : "7:15 PM";
          const partySize = Number(args.partySize ?? args.party_size ?? 2);
          return {
            confirmationCode: `RSV-${Date.now().toString().slice(-6)}`,
            name,
            date,
            time,
            partySize,
          };
        },
        update_reservation: async (args) => ({
          confirmationCode: typeof args.confirmationCode === "string" ? args.confirmationCode : "RSV-UNKNOWN",
          updatedFields: Object.keys(args),
        }),
        cancel_reservation: async (args) => ({
          confirmationCode: typeof args.confirmationCode === "string" ? args.confirmationCode : "RSV-UNKNOWN",
          canceled: true,
        }),
      };
    }

    if (this.sessionScenario === "customer-support") {
      return {
        lookup_order: async (args) => {
          const orderId = typeof args.orderId === "string" ? args.orderId : "1001";
          const fixture = BACKGROUND_SUPPORT_ORDER_FIXTURES[orderId] ?? {
            currency: "GBP",
            status: "processing",
            totalGbp: 24.99,
            items: ["replacement item"],
          };
          return {
            orderId,
            ...fixture,
          };
        },
        start_return: async (args) => ({
          orderId: typeof args.orderId === "string" ? args.orderId : "1001",
          item: typeof args.item === "string" ? args.item : "item",
          returnId: `RET-${Date.now().toString().slice(-6)}`,
          status: "started",
        }),
        update_shipping_address: async (args) => ({
          orderId: typeof args.orderId === "string" ? args.orderId : "1001",
          updated: true,
          city: typeof args.city === "string" ? args.city : "Unknown",
        }),
        escalate_to_human: async (args) => ({
          reason: typeof args.reason === "string" ? args.reason : "general_support",
          queue: "priority-support",
          escalated: true,
        }),
      };
    }

    return {
      add_menu_item: async (args) => {
        const item = this.resolveCartItemFromArgs(args);
        const unitPriceGbp = BACKGROUND_DRIVE_THRU_PRICE_CATALOG[item];
        if (typeof unitPriceGbp !== "number") {
          throw new Error(`Unknown drive-thru menu item: ${item}`);
        }

        const quantityAdded = this.resolveQuantityFromArgs(args);
        const previous = this.backgroundCartItems.get(item);
        const nextQuantity = (previous?.quantity ?? 0) + quantityAdded;
        this.backgroundCartItems.set(item, {
          item,
          quantity: nextQuantity,
          unitPriceGbp,
        });

        const order = this.buildDriveThruSnapshot();
        return {
          item,
          quantityAdded,
          unitPriceGbp,
          lineTotalGbp: this.normalizeCurrency(unitPriceGbp * quantityAdded),
          orderTotalGbp: order.totalGbp,
          orderItemCount: order.itemCount,
        };
      },
      remove_menu_item: async (args) => {
        const item = this.resolveCartItemFromArgs(args);
        const existing = this.backgroundCartItems.get(item);
        if (!existing) {
          throw new Error(`Menu item not in order: ${item}`);
        }

        const quantityRemoved = this.resolveQuantityFromArgs(args);
        const remaining = existing.quantity - quantityRemoved;
        if (remaining > 0) {
          this.backgroundCartItems.set(item, {
            ...existing,
            quantity: remaining,
          });
        } else {
          this.backgroundCartItems.delete(item);
        }

        const order = this.buildDriveThruSnapshot();
        return {
          item,
          quantityRemoved,
          orderTotalGbp: order.totalGbp,
          orderItemCount: order.itemCount,
        };
      },
      get_order_total: async () => this.buildDriveThruSnapshot(),
      submit_order: async () => {
        const order = this.buildDriveThruSnapshot();
        if (order.itemCount === 0) {
          return {
            submitted: false,
            emptyOrder: true,
            totalGbp: 0,
            itemCount: 0,
          };
        }

        const orderId = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
        this.backgroundCartItems.clear();
        return {
          orderId,
          totalGbp: order.totalGbp,
          itemCount: order.itemCount,
          estimatedReadyMinutes: 6,
        };
      },
    };
  }

  private getBackgroundPlanningMode(): BackgroundPlanningMode {
    const textGenerator = this.getProviderRuntime().labels.textGenerator;
    if (textGenerator === "workers-ai") {
      return "workers_ai_native_tool_calls";
    }
    if (textGenerator === "groq") {
      return "groq_native_tool_calls";
    }

    return "structured_json";
  }

  private buildBackgroundPlanningMessages(toolNames: string[], mode: BackgroundPlanningMode): ConversationMessage[] {
    const historyMessages = this.backgroundHistory.map(
      (entry) =>
        ({
          role: entry.role,
          content: `[turn ${entry.turnId} ${entry.origin}] ${entry.content}`,
        }) as ConversationMessage,
    );

    return [{ role: "system", content: buildBackgroundToolSystemPrompt(toolNames, mode, this.sessionScenario) }, ...historyMessages];
  }

  private buildBackgroundFollowupMessages(turnId: number): ConversationMessage[] {
    const historyMessages = this.backgroundHistory.map(
      (entry) =>
        ({
          role: entry.role,
          content: `[turn ${entry.turnId} ${entry.origin}] ${entry.content}`,
        }) as ConversationMessage,
    );

    return [
      { role: "system", content: BACKGROUND_FOLLOWUP_SYSTEM_PROMPT },
      ...historyMessages,
      {
        role: "user",
        content: `Evaluate turn ${turnId}. Write [pass] or one short update.`,
      },
    ];
  }

  private emitBackgroundFollowup(turnId: number, content: string): void {
    const text = content.trim();
    if (!text) {
      return;
    }

    const followupTurnId = this.nextFollowupAssistantTurnId;
    this.nextFollowupAssistantTurnId += 1;
    this.conversationHistory.push({ role: "assistant", content: text });
    this.sendToActiveSocket({
      type: "turn.assistant.final",
      assistantTurnId: followupTurnId,
      text,
    });
    this.deferredFollowupIngestion.push({
      turnId,
      content: text,
    });

    logOperationalEvent("background.followup.emitted", {
      sessionId: this.activeSessionId,
      turnId,
      followupTurnId,
      contentLength: text.length,
    });
  }

  private ingestDeferredFollowupsIfNeeded(userDriven: boolean): void {
    if (!userDriven || this.deferredFollowupIngestion.length === 0) {
      return;
    }

    const pending = [...this.deferredFollowupIngestion];
    this.deferredFollowupIngestion = [];
    for (const followup of pending) {
      this.appendBackgroundHistoryEntry({
        role: "assistant",
        content: followup.content,
        turnId: followup.turnId,
        origin: "assistant_followup",
      });
    }

    logOperationalEvent("background.followup.ingested", {
      sessionId: this.activeSessionId,
      ingestedCount: pending.length,
    });
  }

  private async collectGeneratedText(messages: ConversationMessage[]): Promise<string> {
    let text = "";
    const abortController = new AbortController();
    try {
      for await (const chunk of this.getProviderRuntime().textGenerator.streamText(messages, abortController.signal)) {
        text += chunk;
      }
    } finally {
      abortController.abort();
    }

    return text.trim();
  }

  private async collectBackgroundPlanText(messages: ConversationMessage[]): Promise<string> {
    return this.collectGeneratedText(messages);
  }

  private async collectBackgroundPlanFromGroqNativeCalls(
    messages: ConversationMessage[],
    toolNames: string[],
  ): Promise<{ actions: Array<{ tool: string; args: Record<string, unknown> }>; toolCallCount: number; messageContent: string }> {
    const collect = async (): Promise<{
      actions: Array<{ tool: string; args: Record<string, unknown> }>;
      toolCallCount: number;
      messageContent: string;
    }> => {
      const aiBinding = this.getProviderRuntime().ai ?? this.getEnv()?.AI;
      const abortController = new AbortController();
      try {
        return await generateBackgroundToolPlanWithWorkersAi(messages, toolNames, aiBinding, abortController.signal);
      } finally {
        abortController.abort();
      }
    };

    try {
      return await collect();
    } catch (error) {
      throw error;
    }
  }

  private enqueueBackgroundPass(input: BackgroundPassInput): void {
    this.updateBackgroundTurnResult(input.turnId, "pending");
    logOperationalEvent("background.turn.enqueued", {
      sessionId: this.activeSessionId,
      turnId: input.turnId,
      origin: input.origin,
    });

    this.backgroundQueue = this.backgroundQueue
      .catch(() => {
        // Keep queue processing alive after previous failures.
      })
      .then(async () => {
        await this.runBackgroundPass(input);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.updateBackgroundTurnResult(input.turnId, "failed", [], message);
        logOperationalEvent("background.turn.failed", {
          sessionId: this.activeSessionId,
          turnId: input.turnId,
          groqKeyLabel: this.getSelectedGroqApiKeyLabel(),
          message,
        });
      });
  }

  private async runBackgroundPass(input: BackgroundPassInput): Promise<void> {
    this.updateBackgroundTurnResult(input.turnId, "in_progress");
    this.ingestDeferredFollowupsIfNeeded(input.userDriven);
    this.appendBackgroundHistoryEntry({
      role: "user",
      content: input.userTranscript,
      turnId: input.turnId,
      origin: "user_turn",
    });
    this.appendBackgroundHistoryEntry({
      role: "assistant",
      content: input.assistantText,
      turnId: input.turnId,
      origin: input.origin,
    });

    logOperationalEvent("background.turn.started", {
      sessionId: this.activeSessionId,
      turnId: input.turnId,
      origin: input.origin,
      userDriven: input.userDriven,
      groqKeyLabel: this.getSelectedGroqApiKeyLabel(),
    });

    const toolRegistry = this.getBackgroundToolRegistry();
    const disabled = new Set(this.demoDisabledTools);
    for (const name of disabled) delete toolRegistry[name];
    const toolNames = Object.keys(toolRegistry);
    const planningMode = this.getBackgroundPlanningMode();
    const planningMessages = this.buildBackgroundPlanningMessages(toolNames, planningMode);
    let plannedActions: Array<{ tool: string; args: Record<string, unknown> }> = [];

    if (planningMode === "groq_native_tool_calls" || planningMode === "workers_ai_native_tool_calls") {
      const planResponse = await this.collectBackgroundPlanFromGroqNativeCalls(planningMessages, toolNames);
      plannedActions = planResponse.actions;
      logOperationalEvent("background.turn.plan_tool_calls", {
        sessionId: this.activeSessionId,
        turnId: input.turnId,
        source: planningMode,
        groqKeyLabel: planningMode === "groq_native_tool_calls" ? this.getSelectedGroqApiKeyLabel() : null,
        toolCallCount: planResponse.toolCallCount,
        actionCount: planResponse.actions.length,
        actionTools: planResponse.actions.map((action) => action.tool),
        messageContentLength: planResponse.messageContent.length,
      });
    } else {
      const planText = await this.collectBackgroundPlanText(planningMessages);
      const planTextPreview = planText
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      logOperationalEvent("background.turn.plan_text", {
        sessionId: this.activeSessionId,
        turnId: input.turnId,
        source: "structured_json",
        planTextLength: planText.length,
        planTextPreview,
      });
      const parsedPlan = parseToolPlan(planText);

      if (!parsedPlan) {
        this.updateBackgroundTurnResult(input.turnId, "failed", [], "Invalid background tool plan JSON");
        logOperationalEvent("background.turn.parse_failed", {
          sessionId: this.activeSessionId,
          turnId: input.turnId,
          planTextLength: planText.length,
          planTextPreview,
        });
        return;
      }

      plannedActions = parsedPlan.actions;
    }

    const actionResults = await executeAllowlistedActions(plannedActions, toolRegistry);
    for (const actionResult of actionResults) {
      if (actionResult.ok) {
        continue;
      }

      logOperationalEvent("background.action.failed", {
        sessionId: this.activeSessionId,
        turnId: input.turnId,
        tool: actionResult.tool,
        args: actionResult.args,
        error: actionResult.error,
      });
    }
    this.updateBackgroundTurnResult(input.turnId, "completed", actionResults);
    this.appendBackgroundHistoryEntry({
      role: "assistant",
      content: this.renderBackgroundResultForHistory(input.turnId, actionResults),
      turnId: input.turnId,
      origin: "tool_result",
    });

    if (!ENABLE_BACKGROUND_FOLLOWUPS) {
      logOperationalEvent("background.followup.skipped", {
        sessionId: this.activeSessionId,
        turnId: input.turnId,
        reason: "disabled",
      });
    }

    logOperationalEvent("background.turn.completed", {
      sessionId: this.activeSessionId,
      turnId: input.turnId,
      actionCount: actionResults.length,
      failedActions: actionResults.filter((result) => !result.ok).length,
    });
  }

  private ensureRuntimeState(): void {
    if (!Array.isArray(this.conversationHistory)) {
      this.conversationHistory = [];
    }
    if (typeof this.nextUserTurnId !== "number") {
      this.nextUserTurnId = 1;
    }
    if (typeof this.activeAssistantTurnId !== "number") {
      this.activeAssistantTurnId = 0;
    }
    if (!(this.invalidatedAssistantTurnIds instanceof Set)) {
      this.invalidatedAssistantTurnIds = new Set<number>();
    }
    if (this.activeProviderWork === undefined) {
      this.activeProviderWork = null;
    }
    if (this.pendingCompletedLatency === undefined) {
      this.pendingCompletedLatency = null;
    }
    if (this.pendingCompletedTrace === undefined) {
      this.pendingCompletedTrace = null;
    }
    if (this.providerRuntime === undefined) {
      this.providerRuntime = null;
    }
    if (this.turnDetectorSession === undefined) {
      this.turnDetectorSession = null;
    }
    if (this.turnDetectorConnectPromise === undefined) {
      this.turnDetectorConnectPromise = null;
    }
    if (!isSessionScenario(this.sessionScenario)) {
      this.sessionScenario = DEFAULT_SESSION_SCENARIO;
    }
    if (this.sessionTtsProviderOverride === undefined) {
      this.sessionTtsProviderOverride = null;
    }
    if (this.sessionTtsModelOverride === undefined) {
      this.sessionTtsModelOverride = null;
    }
    if (this.sessionTtsVoiceOverride === undefined) {
      this.sessionTtsVoiceOverride = null;
    }
    if (!(this.backgroundQueue instanceof Promise)) {
      this.backgroundQueue = Promise.resolve();
    }
    if (!Array.isArray(this.backgroundHistory)) {
      this.backgroundHistory = [];
    }
    if (!(this.backgroundTurnResults instanceof Map)) {
      this.backgroundTurnResults = new Map<number, BackgroundTurnResult>();
    }
    if (this.backgroundToolRegistryOverride === undefined) {
      this.backgroundToolRegistryOverride = null;
    }
    if (!(this.backgroundCartItems instanceof Map)) {
      this.backgroundCartItems = new Map<string, BackgroundCartItem>();
    }
    if (!Array.isArray(this.deferredFollowupIngestion)) {
      this.deferredFollowupIngestion = [];
    }
    if (typeof this.nextFollowupAssistantTurnId !== "number" || this.nextFollowupAssistantTurnId < 1_000_000) {
      this.nextFollowupAssistantTurnId = 1_000_000;
    }
    if (typeof this.clientSampleRate !== "number" || this.clientSampleRate <= 0) {
      this.clientSampleRate = DEFAULT_ASSISTANT_AUDIO_SAMPLE_RATE;
    }
    if (typeof this.audioNegotiated !== "boolean") {
      this.audioNegotiated = false;
    }
    if (this.idleHangupTimer === undefined) {
      this.idleHangupTimer = null;
    }
    if (typeof this.userTurnActive !== "boolean") {
      this.userTurnActive = false;
    }
    if (typeof this.assistantPlaybackActive !== "boolean") {
      this.assistantPlaybackActive = false;
    }
    if (this.analyticsDistinctId === undefined) {
      this.analyticsDistinctId = null;
    }
    if (this.analyticsSessionId === undefined) {
      this.analyticsSessionId = null;
    }
  }

  private clearIdleHangupTimer(): void {
    if (this.idleHangupTimer) {
      clearTimeout(this.idleHangupTimer);
      this.idleHangupTimer = null;
    }
  }

  private syncIdleHangupTimer(): void {
    this.clearIdleHangupTimer();

    const activeSocket = this.activeSocket;
    if (
      !activeSocket ||
      !this.audioNegotiated ||
      this.state !== "listening" ||
      this.userTurnActive ||
      this.assistantPlaybackActive
    ) {
      return;
    }

    this.idleHangupTimer = setTimeout(() => {
      if (
        this.activeSocket !== activeSocket ||
        this.state !== "listening" ||
        this.userTurnActive ||
        this.assistantPlaybackActive
      ) {
        return;
      }

      logOperationalEvent("session.idle_timeout", {
        sessionId: this.activeSessionId,
        timeoutMs: IDLE_HANGUP_TIMEOUT_MS,
      });
      this.sendServerMessage(activeSocket, {
        type: "session.closed",
        reason: IDLE_HANGUP_REASON,
      });
      this.clearActiveConnection(activeSocket, "idle_timeout");
      try {
        activeSocket.close(1000, "idle_timeout");
      } catch {
        // Ignore close races during idle hang-up.
      }
    }, IDLE_HANGUP_TIMEOUT_MS);
  }

  private async forwardAudioChunk(message: Uint8Array): Promise<void> {
    if (this.activeSocket === null) {
      return;
    }

    const turnDetectorSession = await this.ensureTurnDetectorSession();
    if (!turnDetectorSession) {
      return;
    }

    turnDetectorSession.sendAudioChunk(message);
  }

  private async ensureTurnDetectorSession(): Promise<TurnDetectorSession | null> {
    this.ensureRuntimeState();

    if (this.turnDetectorSession) {
      return this.turnDetectorSession;
    }

    if (!this.turnDetectorConnectPromise) {
      const turnDetectorSession = this.getProviderRuntime().turnDetector.createSession({
        sampleRate: this.clientSampleRate,
        onStartOfTurn: (transcriptHint) => {
          this.handleStartOfTurn(transcriptHint);
        },
        onEagerEndOfTurn: (transcript) => {
          this.handleEagerEndOfTurn(transcript);
        },
        onEndOfTurn: (finalText) => this.handleEndOfTurn(finalText),
        onTurnResumed: () => {
          this.handleTurnResumed();
        },
        onError: (error) => {
          this.handlePipelineError(error);
        },
      });

      this.turnDetectorSession = turnDetectorSession;
      this.turnDetectorConnectPromise = turnDetectorSession.connect().catch((error) => {
        this.turnDetectorSession = null;
        throw error;
      });
    }

    try {
      await this.turnDetectorConnectPromise;
      return this.turnDetectorSession;
    } catch (error) {
      this.handlePipelineError(error);
      return null;
    } finally {
      this.turnDetectorConnectPromise = null;
    }
  }

  private async prepareSessionForListening(): Promise<void> {
    const activeSocket = this.activeSocket;
    if (!activeSocket || !this.audioNegotiated) {
      return;
    }

    const turnDetectorSession = await this.ensureTurnDetectorSession();
    if (!turnDetectorSession) {
      return;
    }

    if (this.activeSocket !== activeSocket || !this.audioNegotiated) {
      return;
    }

    if (this.state === "connecting") {
      this.transitionState("listening");
    }

    // Workers AI quirk: a llama text inference issued concurrently with the Flux
    // websocket upgrade makes the Flux upgrade fail with InferenceUpstreamError.
    // Only start LLM/TTS prewarm after the turn detector socket is established.
    void this.prewarmSpeechSynthesizer();
    void this.prewarmTextGenerator();
  }

  private cancelActiveAssistantTurn(reason: "start_of_turn" | "client_hint" | "turn_resumed"): void {
    this.ensureRuntimeState();

    const activeWork = this.activeProviderWork;
    const assistantTurnId = activeWork?.assistantTurnId ?? this.activeAssistantTurnId;
    const shouldNotifyClient =
      Boolean(activeWork?.committed) || this.state === "thinking" || this.state === "speaking";

    if (!assistantTurnId || (!activeWork && !shouldNotifyClient)) {
      return;
    }

    if (reason !== "turn_resumed" && activeWork?.speculative && !activeWork.committed) {
      this.logCriticalPathEvent(
        "server.speculative_canceled",
        {
          reason,
          eagerTranscriptText: activeWork.userTranscript,
        },
        activeWork,
      );
    }

    this.invalidatedAssistantTurnIds.add(assistantTurnId);
    activeWork?.llmAbort.abort();
    activeWork?.ttsAbort.abort();
    activeWork?.ttsStream?.close(true);
    this.pendingCompletedLatency = null;
    this.pendingCompletedTrace = null;
    this.activeProviderWork = null;
    this.assistantPlaybackActive = false;

    if (shouldNotifyClient) {
      const clientReason = reason === "turn_resumed" ? "start_of_turn" : reason;
      logOperationalEvent("assistant.turn.interrupted", {
        sessionId: this.activeSessionId,
        assistantTurnId,
        reason,
      });

      this.transitionState("interrupted");
      this.sendToActiveSocket({
        type: "turn.interrupted",
        assistantTurnId,
        reason: clientReason,
      });
      this.transitionState("listening");
      return;
    }

    if (this.state !== "listening") {
      this.transitionState("listening");
    } else {
      this.syncIdleHangupTimer();
    }
  }

  private isAssistantTurnCurrent(assistantTurnId: number): boolean {
    return assistantTurnId === this.activeAssistantTurnId && !this.invalidatedAssistantTurnIds.has(assistantTurnId);
  }

  private transitionState(nextState: SessionState): void {
    if (this.state === nextState) {
      return;
    }

    this.state = nextState;
    logOperationalEvent("session.state.changed", {
      sessionId: this.activeSessionId,
      state: nextState,
    });
    this.sendToActiveSocket({
      type: "session.state",
      state: nextState,
    });
    this.syncIdleHangupTimer();
  }

  private handlePipelineError(error: unknown): void {
    const message =
      error instanceof Error && error.message.length > 0 ? error.message : "Assistant pipeline failed.";
    logOperationalEvent("assistant.pipeline.error_detail", {
      sessionId: this.activeSessionId,
      errorName: error instanceof Error ? error.name : typeof error,
      stack: error instanceof Error ? (error.stack ?? null) : null,
      causeMessage: error instanceof Error && error.cause instanceof Error ? error.cause.message : null,
    });
    this.pendingCompletedLatency = null;
    this.pendingCompletedTrace = null;
    this.captureAnalyticsEvent("voice_agent_pipeline_failed", {
      state: this.state,
      message,
    });
    logOperationalEvent("assistant.turn.failed", {
      sessionId: this.activeSessionId,
      state: this.state,
      groqKeyLabel: this.getSelectedGroqApiKeyLabel(),
      message,
    });
    this.transitionState("error");
    this.sendToActiveSocket({
      type: "session.error",
      code: "ASSISTANT_PIPELINE_FAILED",
      message,
    });
  }

  private getEnv(): SessionEnv | undefined {
    return (this as unknown as { env?: SessionEnv } | undefined)?.env;
  }

  private getEnvValue(key: keyof SessionEnv): string | undefined {
    const env = this.getEnv();
    const value = env?.[key];
    return typeof value === "string" ? value : undefined;
  }

  private shouldCaptureTranscriptAnalytics(): boolean {
    return parseBooleanEnv(this.getEnvValue("POSTHOG_CAPTURE_TRANSCRIPTS"), true);
  }

  private getAnalyticsDistinctId(): string | null {
    if (this.analyticsDistinctId) {
      return this.analyticsDistinctId;
    }

    if (this.activeSessionId) {
      return `voice-session:${this.activeSessionId}`;
    }

    return null;
  }

  private captureAnalyticsEvent(event: string, properties: Record<string, unknown> = {}): void {
    const apiKey = this.getEnvValue("POSTHOG_PROJECT_API_KEY");
    const distinctId = this.getAnalyticsDistinctId();
    if (!apiKey || !distinctId) {
      return;
    }

    const filteredProperties = Object.fromEntries(
      Object.entries({
        app_surface: getPostHogAppSurface(),
        call_session_id: this.activeSessionId,
        posthog_session_id: this.analyticsSessionId,
        scenario: this.sessionScenario,
        tts_provider: this.sessionTtsProviderOverride,
        tts_model: this.sessionTtsModelOverride,
        tts_voice: this.sessionTtsVoiceOverride,
        ...properties,
      }).filter(([, value]) => value !== undefined),
    );

    void capturePostHogEvent({
      apiKey,
      apiHost: normalizePostHogApiHost(this.getEnvValue("POSTHOG_API_HOST")),
      distinctId,
      event,
      properties: filteredProperties,
      timestamp: new Date().toISOString(),
    }).catch((error) => {
      logOperationalEvent("analytics.posthog.capture_failed", {
        sessionId: this.activeSessionId,
        event,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private getRankedGroqApiKeys(): GroqApiKeyRecord[] {
    const sessionId = this.activeSessionId;
    if (!sessionId) {
      return parseGroqApiKeys(undefined, this.getEnvValue("GROQ_API_KEY"));
    }

    if (this.groqRankedApiKeys && this.groqKeySessionId === sessionId) {
      return this.groqRankedApiKeys;
    }

    this.groqKeySessionId = sessionId;
    this.groqPinnedApiKeyIndex = 0;
    this.groqRankedApiKeys = rankGroqApiKeys(
      sessionId,
      parseGroqApiKeys(this.getEnvValue("GROQ_API_KEYS"), this.getEnvValue("GROQ_API_KEY")),
    );
    return this.groqRankedApiKeys;
  }

  private getSelectedGroqApiKey(): string | undefined {
    const rankedKeys = this.getRankedGroqApiKeys();
    const selectedKey = rankedKeys[this.groqPinnedApiKeyIndex];
    return selectedKey?.apiKey;
  }

  private getSelectedGroqApiKeyLabel(): string | null {
    const rankedKeys = this.getRankedGroqApiKeys();
    const selectedKey = rankedKeys[this.groqPinnedApiKeyIndex];
    return selectedKey?.label ?? null;
  }

  private advancePinnedGroqApiKey(): boolean {
    const rankedKeys = this.getRankedGroqApiKeys();
    if (this.groqPinnedApiKeyIndex >= rankedKeys.length - 1) {
      return false;
    }

    const previousKey = rankedKeys[this.groqPinnedApiKeyIndex];
    this.groqPinnedApiKeyIndex += 1;
    const nextKey = rankedKeys[this.groqPinnedApiKeyIndex];
    this.providerRuntime?.dispose?.();
    this.providerRuntime = null;
    logOperationalEvent("llm.groq_session_repin", {
      sessionId: this.activeSessionId,
      previousKeyLabel: previousKey?.label ?? null,
      nextKeyLabel: nextKey?.label ?? null,
    });
    return true;
  }

  private getProviderRuntime(): ProviderRuntime {
    if (!this.providerRuntime) {
      this.providerRuntime = createDefaultProviderRuntime({
        getEnvValue: (key) => this.getEnvValue(key as keyof SessionEnv),
        ai: this.getEnv()?.AI,
        groqApiKey: this.getSelectedGroqApiKey(),
        ttsProviderOverride: this.sessionTtsProviderOverride ?? undefined,
        ttsModelOverride: this.sessionTtsModelOverride ?? undefined,
        ttsVoiceOverride: this.sessionTtsVoiceOverride ?? undefined,
      });
    }

    return this.providerRuntime;
  }

  private sendInvalidMessage(ws: WebSocket): void {
    this.sendServerMessage(
      ws,
      sessionErrorMessageSchema.parse({
        type: "session.error",
        code: "INVALID_MESSAGE",
        message: "Message payload must be valid JSON.",
      }),
    );
  }

  private sendToActiveSocket(payload: unknown): void {
    if (!this.activeSocket) {
      return;
    }

    this.sendServerMessage(this.activeSocket, payload);
  }

  private sendBinaryToActiveSocket(bytes: Uint8Array): void {
    this.activeSocket?.send(new Uint8Array(bytes));
  }

  private sendServerMessage(ws: WebSocket, payload: unknown): void {
    try {
      const parsed = serverMessageSchema.parse(payload);
      ws.send(JSON.stringify(parsed));
    } catch {
      // Socket may already be closed during close/error handlers.
    }
  }

  private clearActiveConnection(ws: WebSocket, reason = "session_cleared"): void {
    if (this.activeSocket !== ws) {
      return;
    }

    this.captureAnalyticsEvent("voice_agent_call_ended", { reason });
    this.resetConversationStateForNewCall();
    this.turnDetectorSession?.close();
    this.turnDetectorSession = null;
    this.turnDetectorConnectPromise = null;
    this.providerRuntime?.dispose?.();
    this.providerRuntime = null;
    this.groqRankedApiKeys = null;
    this.groqPinnedApiKeyIndex = 0;
    this.groqKeySessionId = null;
    this.audioNegotiated = false;
    this.sessionScenario = DEFAULT_SESSION_SCENARIO;
    this.sessionTtsProviderOverride = null;
    this.sessionTtsModelOverride = null;
    this.sessionTtsVoiceOverride = null;
    logOperationalEvent("session.disconnected", {
      sessionId: this.activeSessionId,
    });
    this.activeSocket = null;
    this.activeSessionId = null;
    this.state = "idle";
  }

  private resetConversationStateForNewCall(): void {
    this.clearIdleHangupTimer();
    this.cancelActiveAssistantTurn("client_hint");
    this.lastAcceptedAudioChunkSequence = null;
    this.conversationHistory = [];
    this.nextUserTurnId = 1;
    this.activeAssistantTurnId = 0;
    this.userTurnActive = false;
    this.assistantPlaybackActive = false;
    this.invalidatedAssistantTurnIds = new Set<number>();
    this.pendingCompletedLatency = null;
    this.pendingCompletedTrace = null;
    this.backgroundQueue = Promise.resolve();
    this.backgroundHistory = [];
    this.backgroundTurnResults = new Map<number, BackgroundTurnResult>();
    this.backgroundToolRegistryOverride = null;
    this.backgroundCartItems = new Map<string, BackgroundCartItem>();
    this.deferredFollowupIngestion = [];
    this.nextFollowupAssistantTurnId = 1_000_000;
    this.analyticsDistinctId = null;
    this.analyticsSessionId = null;
  }

  private handleAssistantPlaybackStarted(assistantTurnId: number, clientTsMs?: number): void {
    this.assistantPlaybackActive = true;
    this.syncIdleHangupTimer();
    const activeWork = this.activeProviderWork;
    if (activeWork?.assistantTurnId === assistantTurnId) {
      activeWork.latencyTracker.mark("playbackStart");
      this.logCriticalPathEvent(
        "server.playback_started_received",
        {
          clientTsMs: clientTsMs ?? null,
        },
        activeWork,
      );
      this.sendPartialTrace(activeWork.latencyTracker, activeWork.assistantTurnId);
      if (!activeWork.latencyLogged) {
        this.logTurnLatency(activeWork.latencyTracker);
        activeWork.latencyLogged = true;
      }
      return;
    }

    if (this.pendingCompletedLatency?.assistantTurnId !== assistantTurnId) {
      return;
    }

    this.pendingCompletedLatency.tracker.mark("playbackStart");
    this.sendPartialTrace(this.pendingCompletedLatency.tracker, assistantTurnId);
    this.logCriticalPathEvent("server.playback_started_received", {
      assistantTurnId,
      clientTsMs: clientTsMs ?? null,
    });
    this.logTurnLatency(this.pendingCompletedLatency.tracker);
    this.pendingCompletedLatency = null;

    if (this.pendingCompletedTrace?.assistantTurnId === assistantTurnId) {
      this.pendingCompletedTrace.tracker.mark("playbackStart");
      this.logTurnTrace(
        this.pendingCompletedTrace.tracker,
        this.pendingCompletedTrace.audioBytesSent,
        this.pendingCompletedTrace.audioSampleRate,
      );
      this.pendingCompletedTrace = null;
    }
  }

  private handleAssistantPlaybackEnded(assistantTurnId: number, clientTsMs?: number): void {
    const playbackTurnMatches =
      this.activeAssistantTurnId === assistantTurnId ||
      this.activeProviderWork?.assistantTurnId === assistantTurnId ||
      this.pendingCompletedTrace?.assistantTurnId === assistantTurnId ||
      this.pendingCompletedLatency?.assistantTurnId === assistantTurnId;
    if (playbackTurnMatches) {
      this.assistantPlaybackActive = false;
      this.syncIdleHangupTimer();
    }

    const pendingTrace = this.pendingCompletedTrace;
    if (pendingTrace?.assistantTurnId !== assistantTurnId) {
      return;
    }

    pendingTrace.tracker.mark("playbackEnd");
    this.logCriticalPathEvent(
      "server.playback_ended_received",
      {
        assistantTurnId,
        clientTsMs: clientTsMs ?? null,
      },
      this.activeProviderWork?.assistantTurnId === assistantTurnId ? this.activeProviderWork : null,
    );
    this.logTurnTrace(pendingTrace.tracker, pendingTrace.audioBytesSent, pendingTrace.audioSampleRate);
    this.pendingCompletedTrace = null;
  }

  private logTurnLatency(tracker: TurnLatencyTracker): void {
    logOperationalEvent("turn.latency", {
      sessionId: this.activeSessionId,
      ...summarizeLatencyFields(tracker),
    });
  }

  private sendPartialTrace(tracker: TurnLatencyTracker, assistantTurnId: number): void {
    if (!tracker.hasMark("endOfTurn")) {
      return;
    }
    const marks = tracker.getMarksRelativeTo("endOfTurn");
    this.sendToActiveSocket({
      type: "turn.trace",
      assistantTurnId,
      marksFromEndOfTurnMs: marks as Record<string, number>,
    });
  }

  private logTurnTrace(tracker: TurnLatencyTracker, audioBytesSent: number, audioSampleRate: number): void {
    const traceFields = summarizeTraceFields(tracker, audioBytesSent, audioSampleRate);
    this.captureAnalyticsEvent("voice_agent_turn_trace", {
      assistant_turn_id: traceFields.assistantTurnId,
      turn_id: traceFields.userTurnId,
      turn_detector: traceFields.turnDetector,
      text_generator: traceFields.textGenerator,
      speech_synthesizer: traceFields.speechSynthesizer,
      used_speculative_start: traceFields.usedSpeculativeStart,
      audio_sample_rate: traceFields.audioSampleRate,
      ...(typeof traceFields.endOfTurnToFirstTextMs === "number"
        ? { llm_ttft_ms: traceFields.endOfTurnToFirstTextMs }
        : {}),
      ...(typeof traceFields.endOfTurnToFirstAudioMs === "number" ? { ttfa_ms: traceFields.endOfTurnToFirstAudioMs } : {}),
      ...(typeof traceFields.endOfTurnToPlaybackStartMs === "number"
        ? { playback_start_ms: traceFields.endOfTurnToPlaybackStartMs }
        : {}),
      ...(typeof traceFields.endOfTurnToPlaybackEndMs === "number"
        ? { playback_end_ms: traceFields.endOfTurnToPlaybackEndMs }
        : {}),
      marks_from_end_of_turn_ms: traceFields.marksFromEndOfTurnMs,
    });
    logOperationalEvent("turn.trace", {
      sessionId: this.activeSessionId,
      ...traceFields,
    });
    this.sendToActiveSocket({
      type: "turn.trace",
      assistantTurnId: traceFields.assistantTurnId,
      marksFromEndOfTurnMs: traceFields.marksFromEndOfTurnMs,
    });
  }

  private async prewarmSpeechSynthesizer(): Promise<void> {
    try {
      await this.getProviderRuntime().speechSynthesizer.prewarm?.();
    } catch {
      // Prewarming is opportunistic; turn-time connection still retries on demand.
    }
  }

  private async prewarmTextGenerator(): Promise<void> {
    if (!ENABLE_LLM_PREWARM || !ENABLE_VOICE_SYSTEM_PROMPT) {
      return;
    }

    const messages: ConversationMessage[] = [{ role: "system", content: this.getVoiceAgentSystemPrompt() }];
    const abortController = new AbortController();

    try {
      const stream = this.getProviderRuntime().textGenerator.streamText(messages, abortController.signal, (usage) => {
        logOperationalEvent("llm.prewarm.usage", {
          sessionId: this.activeSessionId,
          model: this.getProviderRuntime().labels.textGenerator,
          promptTokens: usage.promptTokens ?? null,
          completionTokens: usage.completionTokens ?? null,
          totalTokens: usage.totalTokens ?? null,
          cachedTokens: usage.cachedTokens ?? null,
          queueTime: usage.queueTime ?? null,
          promptTime: usage.promptTime ?? null,
          completionTime: usage.completionTime ?? null,
          totalTime: usage.totalTime ?? null,
        });
      });
      for await (const _ of stream) {
        break;
      }
    } catch {
      // Prompt-cache warming is opportunistic only.
    } finally {
      abortController.abort();
    }
  }
}
