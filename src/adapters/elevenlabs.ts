import { Pcm16GainProcessor, applyPcm16Gain } from "./pcm-gain";

const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
const ELEVENLABS_OUTPUT_FORMAT = "pcm_16000";
export const ELEVENLABS_SAMPLE_RATE = 16000;
export const ELEVENLABS_DEFAULT_MODEL = ELEVENLABS_MODEL_ID;
const ELEVENLABS_INACTIVITY_TIMEOUT_SECONDS = 180;
const ELEVENLABS_FLUSH_IDLE_SETTLE_MS = 250;
const ELEVENLABS_FLUSH_NO_AUDIO_TIMEOUT_MS = 1500;
const ELEVENLABS_LEADING_TRIM_THRESHOLD = 256;
const ELEVENLABS_MAX_LEADING_TRIM_BYTES = 16000;

type ElevenLabsStreamOptions = {
  voiceId: string | undefined;
  apiKey: string | undefined;
  onAudioChunk: (chunk: Uint8Array) => void;
  onError?: (error: Error) => void;
  gainDb?: number;
};

type ElevenLabsMessage = {
  audio?: string;
  contextId?: string;
  context_id?: string;
  error?: string | { message?: string };
  isFinal?: boolean;
  is_final?: boolean;
};

type ContextState = {
  onAudioChunk: (chunk: Uint8Array) => void;
  onError?: (error: Error) => void;
  finished: Promise<void>;
  resolveFinished: () => void;
  rejectFinished: (error: unknown) => void;
  flushed: boolean;
  sawAudio: boolean;
  settled: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  noAudioTimer: ReturnType<typeof setTimeout> | null;
};

function decodeBase64(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  throw new Error("No base64 decoder available.");
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function logLeadingTrim(fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event: "tts.leading_trim",
      ts: new Date().toISOString(),
      provider: "elevenlabs",
      ...fields,
    }),
  );
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  return Uint8Array.from([...left, ...right]) as Uint8Array;
}

function findLeadingSpeechOffset(pcmBytes: Uint8Array, threshold: number): number | null {
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  for (let offset = 0; offset + 1 < pcmBytes.byteLength; offset += 2) {
    const sample = Math.abs(view.getInt16(offset, true));
    if (sample > threshold) {
      return offset;
    }
  }

  return null;
}

function createContextState(
  onAudioChunk: (chunk: Uint8Array) => void,
  onError?: (error: Error) => void,
): ContextState {
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  return {
    onAudioChunk,
    onError,
    finished,
    resolveFinished,
    rejectFinished,
    flushed: false,
    sawAudio: false,
    settled: false,
    idleTimer: null,
    noAudioTimer: null,
  };
}

export class ElevenLabsMultiContextSocket {
  private readonly voiceId: string | undefined;
  private readonly apiKey: string | undefined;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly contexts = new Map<string, ContextState>();

  constructor(options: { voiceId: string | undefined; apiKey: string | undefined }) {
    this.voiceId = options.voiceId;
    this.apiKey = options.apiKey;
  }

  async connect(): Promise<void> {
    if (!this.voiceId) {
      throw new Error("Missing ELEVENLABS_VOICE_ID.");
    }
    if (!this.apiKey) {
      throw new Error("Missing ELEVENLABS_API_KEY.");
    }
    if (this.socket) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  registerContext(
    contextId: string,
    onAudioChunk: (chunk: Uint8Array) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    const existing = this.contexts.get(contextId);
    if (existing) {
      existing.onAudioChunk = onAudioChunk;
      existing.onError = onError;
      return existing.finished;
    }

    const context = createContextState(onAudioChunk, onError);
    this.contexts.set(contextId, context);
    return context.finished;
  }

  send(payload: Record<string, unknown>): void {
    if (!this.socket) {
      throw new Error("ElevenLabs websocket is not connected.");
    }

    this.socket.send(JSON.stringify(payload));
  }

  markFlushed(contextId: string): void {
    const context = this.contexts.get(contextId);
    if (!context) {
      return;
    }

    context.flushed = true;
    this.resetNoAudioTimer(contextId, context);
  }

  closeContext(contextId: string, aborted = false): void {
    const context = this.contexts.get(contextId);
    this.contexts.delete(contextId);
    this.clearTimers(context);

    if (this.socket) {
      try {
        this.socket.send(JSON.stringify({ context_id: contextId, close_context: true }));
      } catch {
        // Ignore socket close races.
      }
    }

    if (aborted) {
      context?.rejectFinished(createAbortError());
      return;
    }

    context?.resolveFinished();
  }

  closeSocket(aborted = false): void {
    const socket = this.socket;
    this.socket = null;

    if (socket) {
      try {
        socket.send(JSON.stringify({ close_socket: true }));
      } catch {
        // Ignore socket close races.
      }

      try {
        socket.close(1000, "session_closed");
      } catch {
        // Ignore socket close races.
      }
    }

    const terminalError = aborted ? createAbortError() : new Error("ElevenLabs websocket closed.");
    for (const context of this.contexts.values()) {
      this.clearTimers(context);
      context.rejectFinished(terminalError);
    }
    this.contexts.clear();
  }

  private async openSocket(): Promise<void> {
    const url = new URL(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId ?? "")}/multi-stream-input`,
    );
    url.searchParams.set("model_id", ELEVENLABS_MODEL_ID);
    url.searchParams.set("output_format", ELEVENLABS_OUTPUT_FORMAT);
    url.searchParams.set("auto_mode", "true");
    url.searchParams.set("inactivity_timeout", String(ELEVENLABS_INACTIVITY_TIMEOUT_SECONDS));

    const response = await fetch(url, {
      headers: {
        "xi-api-key": this.apiKey ?? "",
        Upgrade: "websocket",
      },
    });

    const socket = response.webSocket;
    if (!socket) {
      throw new Error(`ElevenLabs websocket upgrade failed with status ${response.status}`);
    }

    socket.accept();
    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer | ArrayBufferView>) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.socket = null;
      const error = new Error("ElevenLabs websocket closed.");
      for (const context of this.contexts.values()) {
        this.clearTimers(context);
        context.rejectFinished(error);
        context.onError?.(error);
      }
      this.contexts.clear();
    });
    socket.addEventListener("error", () => {
      const error = new Error("ElevenLabs websocket error.");
      for (const context of this.contexts.values()) {
        this.clearTimers(context);
        context.rejectFinished(error);
        context.onError?.(error);
      }
      this.contexts.clear();
      this.socket = null;
    });

    this.socket = socket;
  }

  private handleMessage(rawData: string | ArrayBuffer | ArrayBufferView): void {
    let payloadText = "";
    if (typeof rawData === "string") {
      payloadText = rawData;
    } else if (rawData instanceof ArrayBuffer) {
      payloadText = new TextDecoder().decode(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      payloadText = new TextDecoder().decode(rawData);
    } else {
      return;
    }

    let parsed: ElevenLabsMessage;
    try {
      parsed = JSON.parse(payloadText) as ElevenLabsMessage;
    } catch {
      return;
    }

    const contextId = parsed.contextId ?? parsed.context_id;
    const context = contextId ? this.contexts.get(contextId) : undefined;

    if (parsed.audio && context) {
      context.sawAudio = true;
      if (context.noAudioTimer) {
        clearTimeout(context.noAudioTimer);
        context.noAudioTimer = null;
      }
      context.onAudioChunk(decodeBase64(parsed.audio));
      if (context.flushed) {
        this.resetIdleTimer(contextId!, context);
      }
    }

    if (parsed.error) {
      const errorMessage =
        typeof parsed.error === "string" ? parsed.error : parsed.error.message ?? "ElevenLabs synthesis failed.";
      const error = new Error(errorMessage);
      if (context) {
        this.clearTimers(context);
        context.rejectFinished(error);
        context.onError?.(error);
        this.contexts.delete(contextId!);
      }
      return;
    }

    if ((parsed.isFinal === true || parsed.is_final === true) && context) {
      this.clearTimers(context);
      context.settled = true;
      context.resolveFinished();
    }
  }

  private resetIdleTimer(contextId: string, context: ContextState): void {
    if (context.idleTimer) {
      clearTimeout(context.idleTimer);
    }

    context.idleTimer = setTimeout(() => {
      if (!this.contexts.has(contextId) || context.settled) {
        return;
      }

      context.settled = true;
      this.clearTimers(context);
      context.resolveFinished();
    }, ELEVENLABS_FLUSH_IDLE_SETTLE_MS);
  }

  private resetNoAudioTimer(contextId: string, context: ContextState): void {
    if (context.noAudioTimer || context.settled) {
      return;
    }

    context.noAudioTimer = setTimeout(() => {
      if (!this.contexts.has(contextId) || context.settled || context.sawAudio) {
        return;
      }

      context.settled = true;
      this.clearTimers(context);
      context.resolveFinished();
    }, ELEVENLABS_FLUSH_NO_AUDIO_TIMEOUT_MS);
  }

  private clearTimers(context: ContextState | undefined): void {
    if (!context) {
      return;
    }

    if (context.idleTimer) {
      clearTimeout(context.idleTimer);
      context.idleTimer = null;
    }
    if (context.noAudioTimer) {
      clearTimeout(context.noAudioTimer);
      context.noAudioTimer = null;
    }
  }
}

export class ElevenLabsTtsStream {
  private readonly manager: ElevenLabsMultiContextSocket;
  private readonly onAudioChunk: (chunk: Uint8Array) => void;
  private readonly onError?: (error: Error) => void;
  private readonly gainDb: number;
  private readonly gainProcessor: Pcm16GainProcessor;
  private readonly contextId: string;
  private connected = false;
  private firstMessageSent = false;
  private finished: Promise<void> | null = null;
  private leadingTrimPending = true;
  private leadingTrimBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(manager: ElevenLabsMultiContextSocket, options: ElevenLabsStreamOptions) {
    this.manager = manager;
    this.onAudioChunk = options.onAudioChunk;
    this.onError = options.onError;
    this.gainDb = options.gainDb ?? 0;
    this.gainProcessor = new Pcm16GainProcessor(this.gainDb);
    this.contextId = crypto.randomUUID();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.manager.connect();
    this.finished = this.manager.registerContext(this.contextId, (chunk) => this.handleAudioChunk(chunk), this.onError);
    this.connected = true;
  }

  sendText(text: string): void {
    if (!this.connected || !text) {
      return;
    }

    const payload: Record<string, unknown> = {
      context_id: this.contextId,
      text,
    };
    if (!this.firstMessageSent) {
      payload.voice_settings = {
        speed: 1,
        stability: 0.5,
        similarity_boost: 0.8,
      };
      this.firstMessageSent = true;
    }
    this.manager.send(payload);
  }

  async flush(): Promise<void> {
    if (!this.connected || !this.finished) {
      return;
    }

    this.manager.markFlushed(this.contextId);
    this.manager.send({
      context_id: this.contextId,
      flush: true,
    });
    await this.finished;
  }

  close(aborted = false): void {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    this.manager.closeContext(this.contextId, aborted);
  }

  private handleAudioChunk(chunk: Uint8Array): void {
    const gainedChunk = this.gainProcessor.process(chunk);
    if (gainedChunk.byteLength === 0) {
      return;
    }
    if (!this.leadingTrimPending) {
      this.onAudioChunk(gainedChunk);
      return;
    }

    this.leadingTrimBuffer = concatBytes(this.leadingTrimBuffer, gainedChunk);
    const speechOffset = findLeadingSpeechOffset(this.leadingTrimBuffer, ELEVENLABS_LEADING_TRIM_THRESHOLD);

    if (speechOffset !== null) {
      const trimmedChunk = this.leadingTrimBuffer.slice(speechOffset) as Uint8Array;
      logLeadingTrim({
        outcome: "applied",
        trimmedBytes: speechOffset,
        trimmedMs: Math.round(speechOffset / 32),
        threshold: ELEVENLABS_LEADING_TRIM_THRESHOLD,
        sampleRate: ELEVENLABS_SAMPLE_RATE,
      });
      this.leadingTrimPending = false;
      this.leadingTrimBuffer = new Uint8Array(0);
      if (trimmedChunk.byteLength > 0) {
        this.onAudioChunk(trimmedChunk);
      }
      return;
    }

    if (this.leadingTrimBuffer.byteLength >= ELEVENLABS_MAX_LEADING_TRIM_BYTES) {
      logLeadingTrim({
        outcome: "bypassed",
        reason: "max_window_reached",
        bufferedBytes: this.leadingTrimBuffer.byteLength,
        bufferedMs: Math.round(this.leadingTrimBuffer.byteLength / 32),
        threshold: ELEVENLABS_LEADING_TRIM_THRESHOLD,
        sampleRate: ELEVENLABS_SAMPLE_RATE,
      });
      this.leadingTrimPending = false;
      const bufferedChunk = this.leadingTrimBuffer;
      this.leadingTrimBuffer = new Uint8Array(0);
      if (bufferedChunk.byteLength > 0) {
        this.onAudioChunk(bufferedChunk);
      }
    }
  }
}

export async function synthesizeAssistantAudio(
  text: string,
  voiceId: string | undefined,
  apiKey: string | undefined,
  abortSignal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const manager = new ElevenLabsMultiContextSocket({ voiceId, apiKey });
  const stream = new ElevenLabsTtsStream(manager, {
    voiceId,
    apiKey,
    onAudioChunk: (chunk) => {
      chunks.push(chunk);
    },
  });

  await stream.connect();
  stream.sendText(text);
  abortSignal.addEventListener(
    "abort",
    () => {
      stream.close(true);
      manager.closeSocket(true);
    },
    { once: true },
  );
  await stream.flush();
  stream.close();
  manager.closeSocket();

  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export const __test__ = {
  applyPcm16Gain,
  findLeadingSpeechOffset,
};
