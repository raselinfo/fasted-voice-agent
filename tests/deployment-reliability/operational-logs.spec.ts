import { afterEach, describe, expect, it, vi } from "vitest";

const groqState = vi.hoisted(() => ({
  generateAssistantText: vi.fn(async () => "Assistant reply"),
}));

const elevenlabsState = vi.hoisted(() => ({
  synthesizeAssistantAudio: vi.fn(async () => "QUJD"),
}));

vi.mock("../../src/adapters/groq", () => ({
  generateAssistantText: groqState.generateAssistantText,
}));

vi.mock("../../src/adapters/elevenlabs", () => ({
  ELEVENLABS_SAMPLE_RATE: 16000,
  ElevenLabsMultiContextSocket: class {
    async connect() {}
    registerContext() {
      return Promise.resolve();
    }
    send() {}
    closeContext() {}
    closeSocket() {}
  },
  ElevenLabsTtsStream: class {},
  synthesizeAssistantAudio: elevenlabsState.synthesizeAssistantAudio,
}));

type SessionDOProbe = {
  activeSocket: WebSocket | null;
  activeSessionId: string | null;
  state: "idle" | "requesting_mic" | "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "error";
  lastAcceptedAudioChunkSequence: number | null;
  handleEndOfTurn(finalTranscript: string): Promise<void>;
  handleStartOfTurn(transcriptHint?: string): void;
  providerRuntime?: unknown;
};

class CapturingSocket {
  readonly sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }
}

async function createSession(socket: WebSocket): Promise<SessionDOProbe> {
  const { SessionDO } = await import("../../src/durable/session-do");
  const session = Object.create(SessionDO.prototype) as SessionDOProbe;
  session.activeSocket = socket;
  session.activeSessionId = "phase3-logs";
  session.state = "listening";
  session.lastAcceptedAudioChunkSequence = null;
  session.providerRuntime = {
    labels: {
      turnDetector: "test-turn-detector",
      textGenerator: "test-text-generator",
      speechSynthesizer: "test-speech-synthesizer",
    },
    turnDetector: {
      createSession() {
        throw new Error("Not used in this test.");
      },
    },
    textGenerator: {
      async *streamText() {
        yield "Assistant reply.";
      },
    },
    speechSynthesizer: {
      sampleRate: 16000,
      createStream(options: { onAudioChunk: (chunk: Uint8Array) => void }) {
        const sent: string[] = [];

        return {
          async connect() {},
          sendText(text: string) {
            sent.push(text);
          },
          async flush() {
            options.onAudioChunk(new TextEncoder().encode(sent.join("")));
          },
          close() {},
        };
      },
    },
  };
  return session;
}

afterEach(() => {
  groqState.generateAssistantText.mockClear();
  elevenlabsState.synthesizeAssistantAudio.mockClear();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Phase 3 operational logs", () => {
  it("RELY-03 emits structured console logs for completed turns and interruptions", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    await session.handleEndOfTurn("Hello there");
    session.state = "speaking";
    session.handleStartOfTurn("interrupt");

    const events = consoleSpy.mock.calls.map(([payload]) => JSON.parse(String(payload)).event);

    expect(events).toContain("turn.user.finalized");
    expect(events).toContain("assistant.turn.started");
    expect(events).toContain("assistant.turn.generated");
    expect(events).toContain("assistant.turn.completed");
    expect(events).toContain("assistant.turn.interrupted");
  }, 15_000);
});
