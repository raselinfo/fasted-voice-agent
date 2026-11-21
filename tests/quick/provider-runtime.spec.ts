import { afterEach, describe, expect, it, vi } from "vitest";

import { serverMessageSchema } from "../../src/protocol/messages";
import { createDefaultProviderRuntime } from "../../src/providers/default-runtime";
import { parseGroqApiKeys, rankGroqApiKeys, selectGroqApiKey } from "../../src/providers/groq-key-pool";
import type {
  ConversationMessage,
  ProviderRuntime,
  TurnDetectorSessionOptions,
  WorkersAiBinding,
} from "../../src/providers/contracts";

type SessionDOProbe = {
  activeSocket: WebSocket | null;
  activeSessionId: string | null;
  state: "idle" | "listening" | "thinking" | "speaking" | "interrupted" | "error";
  lastAcceptedAudioChunkSequence: number | null;
  providerRuntime?: ProviderRuntime | null;
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

function createFakeRuntime(): ProviderRuntime {
  return {
    labels: {
      turnDetector: "fake-turn-detector",
      textGenerator: "fake-llm",
      speechSynthesizer: "fake-tts",
    },
    turnDetector: {
      createSession() {
        return {
          async connect() {},
          sendAudioChunk() {},
          close() {},
        };
      },
    },
    textGenerator: {
      async *streamText(_messages: ConversationMessage[], _signal: AbortSignal) {
        yield "fake reply.";
      },
    },
    speechSynthesizer: {
      sampleRate: 16000,
      prewarm: vi.fn(async () => {}),
      createStream({ onAudioChunk }) {
        const chunks: string[] = [];
        return {
          async connect() {},
          sendText(text: string) {
            chunks.push(text);
          },
          async flush() {
            onAudioChunk(new TextEncoder().encode(chunks.join("")));
          },
          close() {},
        };
      },
    },
  };
}

class FakeFluxSocket {
  accepted = false;
  closed = false;
  readonly sentBinary: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  accept(): void {
    this.accepted = true;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: ArrayBuffer | ArrayBufferView): void {
    if (payload instanceof ArrayBuffer) {
      this.sentBinary.push(new Uint8Array(payload));
      return;
    }

    this.sentBinary.push(new Uint8Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)));
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }

  emitError(): void {
    this.emit("error", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createTurnOptions(overrides: Partial<TurnDetectorSessionOptions> = {}): TurnDetectorSessionOptions {
  return {
    sampleRate: 16_000,
    onStartOfTurn: vi.fn(),
    onEagerEndOfTurn: vi.fn(),
    onEndOfTurn: vi.fn(),
    onTurnResumed: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

function createEnvValueGetter(values: Record<string, string | undefined>) {
  return (key: string) => values[key];
}

async function createSession(socket: WebSocket, providerRuntime: ProviderRuntime): Promise<SessionDOProbe> {
  const { SessionDO } = await import("../../src/durable/session-do");
  const session = Object.create(SessionDO.prototype) as SessionDOProbe;
  session.activeSocket = socket;
  session.activeSessionId = "provider-runtime";
  session.state = "listening";
  session.lastAcceptedAudioChunkSequence = null;
  session.providerRuntime = providerRuntime;
  return session;
}

afterEach(() => {
  vi.resetModules();
});

describe("Quick provider runtime seam", () => {
  it("selects the same Groq key for the same session and spreads different sessions across the configured pool", () => {
    const keys = parseGroqApiKeys("groq-key-a, groq-key-b, groq-key-c");

    const firstSelection = selectGroqApiKey("session-alpha", keys)?.label;
    const secondSelection = selectGroqApiKey("session-alpha", keys)?.label;
    const distributedSelections = new Set(
      ["session-alpha", "session-beta", "session-gamma", "session-delta"].map(
        (sessionId) => selectGroqApiKey(sessionId, keys)?.label,
      ),
    );

    expect(firstSelection).toBe(secondSelection);
    expect(distributedSelections.size).toBeGreaterThan(1);
  });

  it("repins a session to the next-ranked Groq key after a rate-limit event", async () => {
    const { SessionDO } = await import("../../src/durable/session-do");
    const rankedKeys = rankGroqApiKeys(
      "repin-session",
      parseGroqApiKeys("groq-key-a, groq-key-b, groq-key-c"),
    );
    const dispose = vi.fn();
    const session = Object.assign(Object.create(SessionDO.prototype), {
      activeSessionId: "repin-session",
      groqKeySessionId: "repin-session",
      groqRankedApiKeys: rankedKeys,
      groqPinnedApiKeyIndex: 0,
      providerRuntime: { dispose },
    }) as {
      getSelectedGroqApiKey(): string | undefined;
      advancePinnedGroqApiKey(): boolean;
      groqPinnedApiKeyIndex: number;
      providerRuntime: { dispose: () => void } | null;
    };

    expect(session.getSelectedGroqApiKey()).toBe(rankedKeys[0]?.apiKey);
    expect(session.advancePinnedGroqApiKey()).toBe(true);
    expect(session.groqPinnedApiKeyIndex).toBe(1);
    expect(session.getSelectedGroqApiKey()).toBe(rankedKeys[1]?.apiKey);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(session.providerRuntime).toBeNull();
  });

  it("selects deepgram-direct by default and keeps the Groq plus ElevenLabs baseline runtime", () => {
    const runtime = createDefaultProviderRuntime({
      getEnvValue: createEnvValueGetter({
        DEEPGRAM_KEY: "dg-key",
        GROQ_API_KEY: "groq-key",
        ELEVENLABS_API_KEY: "eleven-key",
        ELEVENLABS_VOICE_ID: "voice-id",
      }),
    });

    expect(runtime.labels).toEqual({
      turnDetector: "deepgram-direct",
      textGenerator: "groq",
      speechSynthesizer: "elevenlabs",
    });

    const session = runtime.turnDetector.createSession(createTurnOptions());
    expect(typeof session.connect).toBe("function");
    expect(typeof session.sendAudioChunk).toBe("function");
    expect(typeof session.close).toBe("function");
  });

  it("selects workers-ai-aura for TTS when configured", async () => {
    const ai: WorkersAiBinding = {
      run: vi.fn(async () => new Response(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]))),
    };

    const runtime = createDefaultProviderRuntime({
      getEnvValue: createEnvValueGetter({
        DEEPGRAM_KEY: "dg-key",
        GROQ_API_KEY: "groq-key",
        TTS_PROVIDER: "workers-ai-aura",
      }),
      ai,
    });

    expect(runtime.labels).toEqual({
      turnDetector: "deepgram-direct",
      textGenerator: "groq",
      speechSynthesizer: "workers-ai-aura",
    });

    expect(runtime.speechSynthesizer.prewarm).toBeDefined();

    const stream = runtime.speechSynthesizer.createStream({
      onAudioChunk: vi.fn(),
      onError: vi.fn(),
    });
    expect(typeof stream.connect).toBe("function");
    expect(typeof stream.sendText).toBe("function");
    expect(typeof stream.flush).toBe("function");
    expect(typeof stream.close).toBe("function");
    await stream.connect();
  });

  it("selects together-orpheus for TTS when configured", async () => {
    const runtime = createDefaultProviderRuntime({
      getEnvValue: createEnvValueGetter({
        DEEPGRAM_KEY: "dg-key",
        GROQ_API_KEY: "groq-key",
        TTS_PROVIDER: "together-orpheus",
        TOGETHER_API_KEY: "together-key",
      }),
    });

    expect(runtime.labels).toEqual({
      turnDetector: "deepgram-direct",
      textGenerator: "groq",
      speechSynthesizer: "together-orpheus",
    });

    const stream = runtime.speechSynthesizer.createStream({
      onAudioChunk: vi.fn(),
      onError: vi.fn(),
    });
    expect(typeof stream.connect).toBe("function");
    expect(typeof stream.sendText).toBe("function");
    expect(typeof stream.flush).toBe("function");
    expect(typeof stream.close).toBe("function");
    await stream.connect();
  });

  it("selects workers-ai-flux, stringifies Flux parameters, and normalizes authoritative turn events", async () => {
    const socket = new FakeFluxSocket();
    const ai: WorkersAiBinding = {
      run: vi.fn(async () => ({ webSocket: socket })),
    };
    const onStartOfTurn = vi.fn();
    const onEagerEndOfTurn = vi.fn();
    const onEndOfTurn = vi.fn();
    const onTurnResumed = vi.fn();

    const runtime = createDefaultProviderRuntime({
      getEnvValue: createEnvValueGetter({
        TURN_DETECTOR_PROVIDER: "workers-ai-flux",
        GROQ_API_KEY: "groq-key",
        ELEVENLABS_API_KEY: "eleven-key",
        ELEVENLABS_VOICE_ID: "voice-id",
      }),
      ai,
    });

    expect(runtime.labels.turnDetector).toBe("workers-ai-flux");

    const session = runtime.turnDetector.createSession(
      createTurnOptions({
        onStartOfTurn,
        onEagerEndOfTurn,
        onEndOfTurn,
        onTurnResumed,
      }),
    );

    await session.connect();

    expect(ai.run).toHaveBeenCalledWith(
      "@cf/deepgram/flux",
      {
        encoding: "linear16",
        sample_rate: "16000",
        eot_threshold: "0.7",
        eager_eot_threshold: "0.3",
        eot_timeout_ms: "1100",
      },
      { websocket: true },
    );
    expect(socket.accepted).toBe(true);

    socket.emitMessage(JSON.stringify({ event: "Update", transcript: "ignore me" }));
    socket.emitMessage(JSON.stringify({ event: "StartOfTurn", transcript: "  hello " }));
    socket.emitMessage(JSON.stringify({ event: "EagerEndOfTurn", transcript: "  partial " }));
    socket.emitMessage(JSON.stringify({ event: "TurnResumed" }));
    socket.emitMessage(JSON.stringify({ event: "EndOfTurn", transcript: " final answer " }));
    await Promise.resolve();

    expect(onStartOfTurn).toHaveBeenCalledWith("hello");
    expect(onEagerEndOfTurn).toHaveBeenCalledWith("partial");
    expect(onTurnResumed).toHaveBeenCalledTimes(1);
    expect(onEndOfTurn).toHaveBeenCalledWith("final answer");

    session.sendAudioChunk(new Uint8Array([1, 2, 3]));
    expect(socket.sentBinary).toEqual([new Uint8Array([1, 2, 3])]);

    session.close();
    expect(socket.closed).toBe(true);
  });

  it("throws clear configuration errors for missing Deepgram secrets or Workers AI binding", () => {
    const defaultRuntime = createDefaultProviderRuntime({
      getEnvValue: createEnvValueGetter({
        GROQ_API_KEY: "groq-key",
        ELEVENLABS_API_KEY: "eleven-key",
        ELEVENLABS_VOICE_ID: "voice-id",
      }),
    });
    const workersRuntime = createDefaultProviderRuntime({
      getEnvValue: createEnvValueGetter({
        TURN_DETECTOR_PROVIDER: "workers-ai-flux",
        GROQ_API_KEY: "groq-key",
        ELEVENLABS_API_KEY: "eleven-key",
        ELEVENLABS_VOICE_ID: "voice-id",
      }),
    });

    expect(() => defaultRuntime.turnDetector.createSession(createTurnOptions())).toThrow("Missing DEEPGRAM_KEY.");
    expect(() => workersRuntime.turnDetector.createSession(createTurnOptions())).toThrow(
      "Missing Workers AI binding.",
    );
  });

  it("runs one assistant turn against a fake provider bundle without importing concrete provider classes", async () => {
    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, createFakeRuntime());

    await session.handleEndOfTurn("hello");

    expect(parseSentMessages(socket)).toContainEqual({
      type: "turn.assistant.final",
      assistantTurnId: 1,
      text: "fake reply.",
    });
    expect(parseSentMessages(socket)).toContainEqual({
      type: "turn.assistant.audio.start",
      assistantTurnId: 1,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });
    expect(parseSentMessages(socket)).toContainEqual({
      type: "turn.assistant.audio.end",
      assistantTurnId: 1,
      isFinal: true,
    });
    expect(socket.sentBinary.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["fake reply."]);
  });

  it("prewarms the speech synthesizer on session.start without coupling SessionDO to a vendor adapter", async () => {
    const socket = new CapturingSocket();
    const baseRuntime = createFakeRuntime();
    const turnDetectorConnect = vi.fn(async () => {});
    const runtime: ProviderRuntime = {
      ...baseRuntime,
      turnDetector: {
        createSession: vi.fn(() => ({
          async connect() {
            await turnDetectorConnect();
          },
          sendAudioChunk() {},
          close() {},
        })),
      },
    };
    const session = await createSession(socket as unknown as WebSocket, runtime);

    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "session.start",
        sessionId: "provider-runtime",
        sampleRate: 48_000,
        audioFormat: {
          encoding: "pcm16",
          channels: 1,
        },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(baseRuntime.speechSynthesizer.prewarm).toHaveBeenCalledTimes(1);
    expect(turnDetectorConnect).toHaveBeenCalledTimes(1);
  });
});
