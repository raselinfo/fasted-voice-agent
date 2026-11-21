import { afterEach, describe, expect, it, vi } from "vitest";

import { serverMessageSchema } from "../../src/protocol/messages";

type ConversationMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const groqState = vi.hoisted(() => ({
  impls: [] as Array<
    (
      messages: ConversationMessage[],
      signal: AbortSignal,
      onUsage?: (usage: Record<string, number | undefined>) => void,
    ) => AsyncGenerator<string>
  >,
}));

const elevenlabsState = vi.hoisted(() => ({
  flushImpls: [] as Array<(texts: string[], onAudioChunk: (chunk: Uint8Array) => void) => Promise<void>>,
}));

vi.mock("../../src/adapters/groq", () => ({
  streamAssistantText: (
    messages: ConversationMessage[],
    _apiKey: string | undefined,
    signal: AbortSignal,
    onUsage?: (usage: Record<string, number | undefined>) => void,
  ) => {
    const impl =
      groqState.impls.shift() ??
      (async function* () {
        yield "fallback.";
      });
    return impl(messages, signal, onUsage);
  },
}));

vi.mock("../../src/adapters/elevenlabs", () => {
  class MockElevenLabsMultiContextSocket {
    async connect(): Promise<void> {}
    registerContext(): Promise<void> {
      return Promise.resolve();
    }
    send(): void {}
    closeContext(): void {}
    closeSocket(): void {}
  }

  class MockElevenLabsTtsStream {
    readonly texts: string[] = [];
    readonly onAudioChunk: (chunk: Uint8Array) => void;

    constructor(
      managerOrOptions: MockElevenLabsMultiContextSocket | { onAudioChunk: (chunk: Uint8Array) => void },
      maybeOptions?: { onAudioChunk: (chunk: Uint8Array) => void },
    ) {
      const options = maybeOptions ?? (managerOrOptions as { onAudioChunk: (chunk: Uint8Array) => void });
      this.onAudioChunk = options.onAudioChunk;
    }

    async connect(): Promise<void> {}

    sendText(text: string): void {
      this.texts.push(text);
    }

    async flush(): Promise<void> {
      const impl =
        elevenlabsState.flushImpls.shift() ??
        (async (texts: string[], onAudioChunk: (chunk: Uint8Array) => void) => {
          onAudioChunk(new TextEncoder().encode(texts.join("")));
        });
      await impl(this.texts, this.onAudioChunk);
    }

    close(): void {}
  }

  return {
    ELEVENLABS_SAMPLE_RATE: 16000,
    ElevenLabsMultiContextSocket: MockElevenLabsMultiContextSocket,
    ElevenLabsTtsStream: MockElevenLabsTtsStream,
  };
});

type SessionDOProbe = {
  activeSocket: WebSocket | null;
  activeSessionId: string | null;
  state: "idle" | "listening" | "thinking" | "speaking" | "interrupted" | "error";
  lastAcceptedAudioChunkSequence: number | null;
  handleStartOfTurn(transcriptHint?: string): void;
  handleEagerEndOfTurn(finalTranscript: string): void;
  handleEndOfTurn(finalTranscript: string): Promise<void>;
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void;
};

class CapturingSocket {
  readonly sentStrings: string[] = [];
  readonly sentBinary: Uint8Array[] = [];

  send(payload: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof payload === "string") {
      this.sentStrings.push(payload);
      return;
    }

    if (payload instanceof ArrayBuffer) {
      this.sentBinary.push(new Uint8Array(payload));
      return;
    }

    this.sentBinary.push(new Uint8Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)));
  }
}

function parseSentMessages(socket: CapturingSocket) {
  return socket.sentStrings.map((payload) => serverMessageSchema.parse(JSON.parse(payload)));
}

function parseLoggedEvents(logSpy: ReturnType<typeof vi.spyOn>) {
  return logSpy.mock.calls
    .map(([payload]: unknown[]) => payload)
    .filter((payload: unknown): payload is string => typeof payload === "string")
    .map((payload: string) => JSON.parse(payload) as Record<string, unknown>);
}

async function waitFor(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error("Condition was not met in time.");
}

async function createSession(socket: WebSocket): Promise<SessionDOProbe> {
  const { SessionDO } = await import("../../src/durable/session-do");
  const session = Object.create(SessionDO.prototype) as SessionDOProbe;
  session.activeSocket = socket;
  session.activeSessionId = "quick-streaming";
  session.state = "listening";
  session.lastAcceptedAudioChunkSequence = null;
  return session;
}

afterEach(() => {
  groqState.impls.length = 0;
  elevenlabsState.flushImpls.length = 0;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Quick latency streaming", () => {
  it("LAT-02 emits audio lifecycle control frames around streamed binary PCM output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    groqState.impls.push(async function* () {
      yield "streamed answer.";
    });

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    await session.handleEndOfTurn("hello");
    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "turn.assistant.playback.started",
        assistantTurnId: 1,
      }),
    );
    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "turn.assistant.playback.ended",
        assistantTurnId: 1,
      }),
    );

    const messages = parseSentMessages(socket);
    expect(messages).toContainEqual({
      type: "turn.assistant.audio.start",
      assistantTurnId: 1,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });
    expect(messages).toContainEqual({
      type: "turn.assistant.audio.end",
      assistantTurnId: 1,
      isFinal: true,
    });
    expect(socket.sentBinary.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["streamed answer."]);

    const latencyEvents = parseLoggedEvents(logSpy).filter(
      (event: Record<string, unknown>) => event.event === "turn.latency",
    );
    expect(latencyEvents).toContainEqual(
      expect.objectContaining({
        turnDetector: "deepgram-direct",
        textGenerator: "groq",
        speechSynthesizer: "elevenlabs",
        usedSpeculativeStart: false,
        endOfTurnToFirstTextMs: expect.any(Number),
        endOfTurnToFirstAudioMs: expect.any(Number),
        endOfTurnToPlaybackStartMs: expect.any(Number),
      }),
    );
    expect(latencyEvents[0]).not.toHaveProperty("endOfTurnToFinalTextMs");
    expect(latencyEvents[0]).not.toHaveProperty("endOfTurnToCompleteMs");

    const traceEvents = parseLoggedEvents(logSpy).filter((event: Record<string, unknown>) => event.event === "turn.trace");
    expect(traceEvents).toContainEqual(
      expect.objectContaining({
        turnDetector: "deepgram-direct",
        textGenerator: "groq",
        speechSynthesizer: "elevenlabs",
        usedSpeculativeStart: false,
        endOfTurnToLlmDoneMs: expect.any(Number),
        endOfTurnToFirstChunkSentToTtsMs: expect.any(Number),
        endOfTurnToTtsDoneMs: expect.any(Number),
        audioDurationMs: expect.any(Number),
        endOfTurnToEstimatedPlaybackEndMs: expect.any(Number),
      }),
    );

    const eventNames = parseLoggedEvents(logSpy).map((event: Record<string, unknown>) => event.event);
    expect(eventNames).toEqual(
      expect.arrayContaining([
        "server.turn_detector_final_eot",
        "server.assistant_turn_committed",
        "server.llm_request_started",
        "server.llm_first_token",
        "server.llm_done",
        "server.tts_first_text_sent",
        "server.tts_first_audio_generated",
        "server.audio_start_sent",
        "server.first_audio_chunk_sent",
        "server.playback_started_received",
      ]),
    );
  });

  it("LAT-03 rejects stale canceled output after interruption", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deferred = createDeferred<string>();

    groqState.impls.push(async function* (_messages: ConversationMessage[], signal: AbortSignal) {
      const text = await deferred.promise;
      if (signal.aborted) {
        throw createAbortError();
      }
      yield text;
    });

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    const pending = session.handleEndOfTurn("hello");
    session.handleStartOfTurn("wait");
    deferred.resolve("stale answer.");
    await pending;

    expect(parseSentMessages(socket)).not.toContainEqual({
      type: "turn.assistant.final",
      assistantTurnId: 1,
      text: "stale answer.",
    });
    expect(socket.sentBinary).toHaveLength(0);

    const latencyEvents = parseLoggedEvents(logSpy).filter(
      (event: Record<string, unknown>) => event.event === "turn.latency",
    );
    expect(latencyEvents).toHaveLength(0);
  });

  it("LAT-04 logs playback-start latency even if the turn is interrupted before TTS flush completes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const flushDeferred = createDeferred<void>();

    groqState.impls.push(async function* () {
      yield "streamed answer.";
    });
    elevenlabsState.flushImpls.push(async (texts, onAudioChunk) => {
      onAudioChunk(new TextEncoder().encode(texts.join("")));
      await flushDeferred.promise;
    });

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    const pending = session.handleEndOfTurn("hello");
    await waitFor(() =>
      parseSentMessages(socket).some(
        (message) => message.type === "turn.assistant.audio.start" && message.assistantTurnId === 1,
      ),
    );

    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "turn.assistant.playback.started",
        assistantTurnId: 1,
      }),
    );
    session.handleStartOfTurn("interrupt");
    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "turn.assistant.playback.ended",
        assistantTurnId: 1,
      }),
    );
    flushDeferred.resolve();
    await pending;

    const latencyEvents = parseLoggedEvents(logSpy).filter(
      (event: Record<string, unknown>) => event.event === "turn.latency",
    );
    expect(latencyEvents).toHaveLength(1);
    expect(latencyEvents[0]).toEqual(
      expect.objectContaining({
        assistantTurnId: 1,
        turnDetector: "deepgram-direct",
        textGenerator: "groq",
        speechSynthesizer: "elevenlabs",
        usedSpeculativeStart: false,
        endOfTurnToFirstTextMs: expect.any(Number),
        endOfTurnToFirstAudioMs: expect.any(Number),
        endOfTurnToPlaybackStartMs: expect.any(Number),
      }),
    );
  });

  it("LAT-05 reports eager lead time when a committed turn used speculative start", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    groqState.impls.push(async function* () {
      yield "speculative answer.";
    });

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    session.handleEagerEndOfTurn("hello");
    await Promise.resolve();
    await session.handleEndOfTurn("hello");
    await waitFor(() =>
      parseSentMessages(socket).some(
        (message) => message.type === "turn.assistant.audio.end" && message.assistantTurnId === 1,
      ),
    );
    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "turn.assistant.playback.started",
        assistantTurnId: 1,
      }),
    );
    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "turn.assistant.playback.ended",
        assistantTurnId: 1,
      }),
    );

    const traceEvents = parseLoggedEvents(logSpy).filter((event: Record<string, unknown>) => event.event === "turn.trace");
    expect(traceEvents).toContainEqual(
      expect.objectContaining({
        assistantTurnId: 1,
        usedSpeculativeStart: true,
        eagerEndOfTurnToEndOfTurnMs: expect.any(Number),
      }),
    );
  });
});
