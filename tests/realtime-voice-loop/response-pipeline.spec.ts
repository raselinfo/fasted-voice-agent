import { afterEach, describe, expect, it, vi } from "vitest";

import { serverMessageSchema } from "../../src/protocol/messages";

type ConversationMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const groqState = vi.hoisted(() => ({
  calls: [] as ConversationMessage[][],
  responses: [] as string[][],
}));

vi.mock("../../src/adapters/groq", () => ({
  streamAssistantText: (messages: ConversationMessage[]) => {
    groqState.calls.push(messages);
    const chunks = groqState.responses.shift() ?? [];

    return (async function* () {
      for (const chunk of chunks) {
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
  handleEndOfTurn(finalTranscript: string): Promise<void>;
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
  session.activeSessionId = "response-pipeline";
  session.state = "listening";
  session.lastAcceptedAudioChunkSequence = null;
  return session;
}

afterEach(() => {
  groqState.calls.length = 0;
  groqState.responses.length = 0;
  vi.resetModules();
});

describe("Phase 2 response pipeline", () => {
  it("RESP-01 sends current session conversation history to Groq", async () => {
    groqState.responses.push(["First answer."], ["Second answer."]);

    const socket = new CapturingSocket();
    const session = await createPhase2Session(socket as unknown as WebSocket);

    await session.handleEndOfTurn("First question");
    await session.handleEndOfTurn("Second question");

    expect(groqState.calls).toHaveLength(2);
    expect(groqState.calls[0][0]).toEqual(
      expect.objectContaining({
        role: "system",
      }),
    );
    expect(groqState.calls[0].slice(1)).toEqual([{ role: "user", content: "First question" }]);
    expect(groqState.calls[1][0]).toEqual(
      expect.objectContaining({
        role: "system",
      }),
    );
    expect(groqState.calls[1].slice(1)).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second question" },
    ]);
  });

  it("RESP-03 preserves history and emits finalized assistant text plus streamed audio across turns", async () => {
    groqState.responses.push(["First answer."], ["Second answer."]);

    const socket = new CapturingSocket();
    const session = await createPhase2Session(socket as unknown as WebSocket);

    await session.handleEndOfTurn("First question");
    await session.handleEndOfTurn("Second question");

    const messages = parseSentMessages(socket).filter((message) => message.type.startsWith("turn."));
    expect(messages).toEqual([
      { type: "turn.user.final", turnId: 1, text: "First question" },
      { type: "turn.assistant.final", assistantTurnId: 1, text: "First answer." },
      {
        type: "turn.assistant.audio.start",
        assistantTurnId: 1,
        sampleRate: 16000,
        encoding: "pcm16",
        channels: 1,
      },
      { type: "turn.assistant.audio.end", assistantTurnId: 1, isFinal: true },
      { type: "turn.user.final", turnId: 2, text: "Second question" },
      { type: "turn.assistant.final", assistantTurnId: 2, text: "Second answer." },
      {
        type: "turn.assistant.audio.start",
        assistantTurnId: 2,
        sampleRate: 16000,
        encoding: "pcm16",
        channels: 1,
      },
      { type: "turn.assistant.audio.end", assistantTurnId: 2, isFinal: true },
    ]);

    expect(socket.sentBinary.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["First answer.", "Second answer."]);
  });
});
