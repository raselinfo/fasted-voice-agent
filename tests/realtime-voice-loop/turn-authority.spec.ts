import { afterEach, describe, expect, it, vi } from "vitest";

import { serverMessageSchema } from "../../src/protocol/messages";

type ConversationMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

const groqState = vi.hoisted(() => ({
  calls: [] as ConversationMessage[][],
  signals: [] as AbortSignal[],
  responses: [] as string[][],
}));

const elevenlabsState = vi.hoisted(() => ({
  sentTexts: [] as string[][],
}));

vi.mock("../../src/adapters/groq", () => ({
  streamAssistantText: (messages: ConversationMessage[], _apiKey: string | undefined, signal: AbortSignal) => {
    groqState.calls.push(messages);
    groqState.signals.push(signal);
    const chunks = groqState.responses.shift() ?? [];

    return (async function* () {
      for (const chunk of chunks) {
        if (signal.aborted) {
          throw createAbortError();
        }
        yield chunk;
      }
    })();
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
    private readonly texts: string[] = [];
    private readonly onAudioChunk: (chunk: Uint8Array) => void;

    constructor(
      managerOrOptions: MockElevenLabsMultiContextSocket | { onAudioChunk: (chunk: Uint8Array) => void },
      maybeOptions?: { onAudioChunk: (chunk: Uint8Array) => void },
    ) {
      const options = maybeOptions ?? (managerOrOptions as { onAudioChunk: (chunk: Uint8Array) => void });
      this.onAudioChunk = options.onAudioChunk;
      elevenlabsState.sentTexts.push(this.texts);
    }

    async connect(): Promise<void> {}

    sendText(text: string): void {
      this.texts.push(text);
    }

    async flush(): Promise<void> {
      this.onAudioChunk(new TextEncoder().encode(this.texts.join("")));
    }

    close(): void {}
  }

  return {
    ELEVENLABS_SAMPLE_RATE: 16000,
    ElevenLabsMultiContextSocket: MockElevenLabsMultiContextSocket,
    ElevenLabsTtsStream: MockElevenLabsTtsStream,
  };
});

vi.mock("../../src/adapters/workers-ai-aura", () => {
  class MockWorkersAiAuraTtsStream {
    private readonly texts: string[] = [];
    private readonly onAudioChunk: (chunk: Uint8Array) => void;

    constructor(options: { onAudioChunk: (chunk: Uint8Array) => void }) {
      this.onAudioChunk = options.onAudioChunk;
      elevenlabsState.sentTexts.push(this.texts);
    }

    async connect(): Promise<void> {}

    sendText(text: string): void {
      this.texts.push(text);
    }

    async flush(): Promise<void> {
      this.onAudioChunk(new TextEncoder().encode(this.texts.join("")));
    }

    close(): void {}
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
  session.activeSessionId = "turn-authority";
  session.state = "listening";
  session.lastAcceptedAudioChunkSequence = null;
  return session;
}

const flushTicks = async (count = 2) => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
};

afterEach(() => {
  groqState.calls.length = 0;
  groqState.signals.length = 0;
  groqState.responses.length = 0;
  elevenlabsState.sentTexts.length = 0;
  vi.resetModules();
});

describe("Phase 2 turn authority", () => {
  it("TURN-02 uses StartOfTurn as authority without starting assistant generation", async () => {
    const socket = new CapturingSocket();
    const session = await createPhase2Session(socket as unknown as WebSocket);

    session.handleStartOfTurn("user started speaking");

    expect(groqState.calls).toEqual([]);
    expect(parseSentMessages(socket)).toEqual([]);
    expect(session.state).toBe("listening");
  });

  it("TURN-03 starts exactly one streamed response pipeline only after authoritative EndOfTurn", async () => {
    groqState.responses.push(["Assistant ", "reply."]);

    const socket = new CapturingSocket();
    const session = await createPhase2Session(socket as unknown as WebSocket);

    session.handleStartOfTurn("hello");
    expect(groqState.calls).toHaveLength(0);

    await session.handleEndOfTurn("hello world");
    await Promise.resolve();
    await Promise.resolve();

    expect(groqState.calls).toHaveLength(1);
    expect(groqState.calls[0][0]).toEqual(
      expect.objectContaining({
        role: "system",
      }),
    );
    expect(groqState.calls[0].slice(1)).toEqual([{ role: "user", content: "hello world" }]);

    const messages = parseSentMessages(socket);
    expect(messages).toEqual([
      { type: "turn.user.final", turnId: 1, text: "hello world" },
      { type: "session.state", state: "thinking" },
      { type: "turn.assistant.final", assistantTurnId: 1, text: "Assistant reply." },
      {
        type: "turn.assistant.audio.start",
        assistantTurnId: 1,
        sampleRate: 16000,
        encoding: "pcm16",
        channels: 1,
      },
      { type: "session.state", state: "speaking" },
      { type: "turn.assistant.audio.end", assistantTurnId: 1, isFinal: true },
      { type: "session.state", state: "listening" },
    ]);
    expect(socket.sentBinary).toHaveLength(1);
    expect(new TextDecoder().decode(socket.sentBinary[0])).toBe("Assistant reply.");
  });

  it("TURN-04 starts speculative generation on eager turn end but does not emit output until EndOfTurn commits it", async () => {
    groqState.responses.push(["Assistant ", "reply."]);

    const socket = new CapturingSocket();
    const session = await createPhase2Session(socket as unknown as WebSocket);

    session.handleEagerEndOfTurn("hello world");
    await flushTicks();

    expect(groqState.calls).toHaveLength(1);
    expect(groqState.calls[0][0]).toEqual(
      expect.objectContaining({
        role: "system",
      }),
    );
    expect(groqState.calls[0].slice(1)).toEqual([{ role: "user", content: "hello world" }]);
    expect(parseSentMessages(socket)).toEqual([]);
    expect(socket.sentBinary).toEqual([]);

    await session.handleEndOfTurn("hello world");
    await flushTicks(8);

    expect(groqState.calls).toHaveLength(1);
    const messages = parseSentMessages(socket);
    expect(messages).toEqual([
      { type: "turn.user.final", turnId: 1, text: "hello world" },
      { type: "session.state", state: "thinking" },
      { type: "turn.assistant.final", assistantTurnId: 1, text: "Assistant reply." },
      {
        type: "turn.assistant.audio.start",
        assistantTurnId: 1,
        sampleRate: 16000,
        encoding: "pcm16",
        channels: 1,
      },
      { type: "session.state", state: "speaking" },
      { type: "turn.assistant.audio.end", assistantTurnId: 1, isFinal: true },
      { type: "session.state", state: "listening" },
    ]);
    expect(socket.sentBinary).toHaveLength(1);
    expect(new TextDecoder().decode(socket.sentBinary[0])).toBe("Assistant reply.");
  });
});
