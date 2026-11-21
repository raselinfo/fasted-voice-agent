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

type StreamImpl = (messages: ConversationMessage[], signal: AbortSignal) => AsyncGenerator<string>;
type FlushImpl = (stream: MockElevenLabsTtsStream) => Promise<void>;

const groqState = vi.hoisted(() => ({
  calls: [] as ConversationMessage[][],
  signals: [] as AbortSignal[],
  impls: [] as StreamImpl[],
}));

const elevenlabsState = vi.hoisted(() => ({
  streams: [] as MockElevenLabsTtsStream[],
  flushImpls: [] as FlushImpl[],
}));

vi.mock("../../src/adapters/groq", () => ({
  streamAssistantText: (messages: ConversationMessage[], _apiKey: string | undefined, signal: AbortSignal) => {
    groqState.calls.push(messages);
    groqState.signals.push(signal);
    const impl =
      groqState.impls.shift() ??
      (async function* (_fallbackMessages: ConversationMessage[], fallbackSignal: AbortSignal) {
        if (fallbackSignal.aborted) {
          throw createAbortError();
        }
      });

    return impl(messages, signal);
  },
}));

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
  abortReject: ((reason?: unknown) => void) | null = null;

  constructor(
    managerOrOptions: MockElevenLabsMultiContextSocket | { onAudioChunk: (chunk: Uint8Array) => void },
    maybeOptions?: { onAudioChunk: (chunk: Uint8Array) => void },
  ) {
    const options = maybeOptions ?? (managerOrOptions as { onAudioChunk: (chunk: Uint8Array) => void });
    this.onAudioChunk = options.onAudioChunk;
    elevenlabsState.streams.push(this);
  }

  async connect(): Promise<void> {}

  sendText(text: string): void {
    this.texts.push(text);
  }

  async flush(): Promise<void> {
    const impl = elevenlabsState.flushImpls.shift();
    if (impl) {
      await impl(this);
      return;
    }

    this.onAudioChunk(new TextEncoder().encode(this.texts.join("")));
  }

  close(aborted = false): void {
    if (aborted) {
      this.abortReject?.(createAbortError());
    }
  }
}

vi.mock("../../src/adapters/elevenlabs", () => ({
  ELEVENLABS_SAMPLE_RATE: 16000,
  ElevenLabsMultiContextSocket: MockElevenLabsMultiContextSocket,
  ElevenLabsTtsStream: MockElevenLabsTtsStream,
}));

vi.mock("../../src/adapters/workers-ai-aura", () => {
  class MockWorkersAiAuraTtsStream {
    readonly texts: string[] = [];
    readonly onAudioChunk: (chunk: Uint8Array) => void;
    abortReject: ((reason?: unknown) => void) | null = null;

    constructor(options: { onAudioChunk: (chunk: Uint8Array) => void }) {
      this.onAudioChunk = options.onAudioChunk;
      elevenlabsState.streams.push(this as unknown as MockElevenLabsTtsStream);
    }

    async connect(): Promise<void> {}

    sendText(text: string): void {
      this.texts.push(text);
    }

    async flush(): Promise<void> {
      const impl = elevenlabsState.flushImpls.shift();
      if (impl) {
        await impl(this as unknown as MockElevenLabsTtsStream);
        return;
      }

      this.onAudioChunk(new TextEncoder().encode(this.texts.join("")));
    }

    close(aborted = false): void {
      if (aborted) {
        this.abortReject?.(createAbortError());
      }
    }
  }

  return {
    WorkersAiAuraTtsStream: MockWorkersAiAuraTtsStream,
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
  handleTurnResumed(): void;
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

async function createPhase2Session(socket: WebSocket): Promise<SessionDOProbe> {
  const { SessionDO } = await import("../../src/durable/session-do");
  const session = Object.create(SessionDO.prototype) as SessionDOProbe;
  session.activeSocket = socket;
  session.activeSessionId = "interruptions";
  session.state = "listening";
  session.lastAcceptedAudioChunkSequence = null;
  return session;
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  groqState.calls.length = 0;
  groqState.signals.length = 0;
  groqState.impls.length = 0;
  elevenlabsState.streams.length = 0;
  elevenlabsState.flushImpls.length = 0;
  vi.resetModules();
});

describe("Phase 2 interruption handling", () => {
  it("INTR-03 drops stale canceled output and only emits text/audio for the active assistantTurnId", async () => {
    const firstTurn = createDeferred<string>();

    groqState.impls.push(
      async function* (_messages: ConversationMessage[], signal: AbortSignal) {
        const text = await firstTurn.promise;
        if (signal.aborted) {
          throw createAbortError();
        }
        yield text;
      },
      async function* () {
        yield "fresh answer.";
      },
    );

    const socket = new CapturingSocket();
    const session = await createPhase2Session(socket as unknown as WebSocket);

    const stalePipeline = session.handleEndOfTurn("First request");
    await flush();

    session.handleStartOfTurn("Interrupting");
    firstTurn.resolve("stale answer.");
    await stalePipeline;

    await session.handleEndOfTurn("Second request");

    const messages = parseSentMessages(socket);
    expect(messages).toContainEqual({
      type: "turn.interrupted",
      assistantTurnId: 1,
      reason: "start_of_turn",
    });
    expect(messages).not.toContainEqual({
      type: "turn.assistant.final",
      assistantTurnId: 1,
      text: "stale answer.",
    });
    expect(messages).toContainEqual({
      type: "turn.assistant.final",
      assistantTurnId: 2,
      text: "fresh answer.",
    });
    expect(messages).toContainEqual({
      type: "turn.assistant.audio.start",
      assistantTurnId: 2,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });
    expect(socket.sentBinary.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["fresh answer."]);
  });

  it("INTR-04 tracks each assistantTurnId and honors client.interrupt as a cancellation hint only", async () => {
    groqState.impls.push(async function* () {
      yield "spoken reply.";
    });
    elevenlabsState.flushImpls.push(async (stream) => {
      await new Promise<void>((_resolve, reject) => {
        stream.abortReject = reject;
      });
    });

    const socket = new CapturingSocket();
    const session = await createPhase2Session(socket as unknown as WebSocket);

    const speakingTurn = session.handleEndOfTurn("Say something");
    await flush();

    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "client.interrupt",
      }),
    );

    expect(groqState.signals[0]?.aborted).toBe(true);
    await speakingTurn;

    const messages = parseSentMessages(socket);
    expect(messages).toContainEqual({
      type: "turn.assistant.final",
      assistantTurnId: 1,
      text: "spoken reply.",
    });
    expect(messages).toContainEqual({
      type: "turn.interrupted",
      assistantTurnId: 1,
      reason: "client_hint",
    });
    expect(messages).not.toContainEqual({
      type: "turn.assistant.audio.end",
      assistantTurnId: 1,
      isFinal: true,
    });
    expect(socket.sentBinary).toHaveLength(0);
  });

  it("INTR-05 cancels speculative eager work on TurnResumed without leaking output", async () => {
    const firstTurn = createDeferred<string>();

    groqState.impls.push(async function* (_messages: ConversationMessage[], signal: AbortSignal) {
      const text = await firstTurn.promise;
      if (signal.aborted) {
        throw createAbortError();
      }
      yield text;
    });

    const socket = new CapturingSocket();
    const session = await createPhase2Session(socket as unknown as WebSocket);

    session.handleEagerEndOfTurn("draft reply");
    await flush();

    session.handleTurnResumed();
    firstTurn.resolve("stale speculative output");
    await flush();

    expect(groqState.signals[0]?.aborted).toBe(true);
    expect(parseSentMessages(socket)).toEqual([]);
    expect(socket.sentBinary).toEqual([]);
    expect(session.state).toBe("listening");
  });
});
