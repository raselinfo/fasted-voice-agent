import { afterEach, describe, expect, it, vi } from "vitest";

import { serverMessageSchema } from "../../src/protocol/messages";

type SessionDOProbe = {
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void;
  webSocketError(ws: WebSocket, error: unknown): void;
  webSocketClose(ws: WebSocket, code: number, reason: string): void;
  activeSocket: WebSocket | null;
  activeSessionId: string | null;
  state: "idle" | "listening" | "error";
  lastAcceptedAudioChunkSequence: number | null;
  providerRuntime?: unknown;
};

class CapturingSocket {
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
  }
}

function parseSentMessages(socket: CapturingSocket) {
  return socket.sent.map((payload) => serverMessageSchema.parse(JSON.parse(payload)));
}

async function createSession(socket: WebSocket): Promise<SessionDOProbe> {
  const { SessionDO } = await import("../../src/durable/session-do");
  const session = Object.create(SessionDO.prototype) as SessionDOProbe;
  session.activeSocket = socket;
  session.activeSessionId = "tab-a";
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
        return {
          async connect() {},
          sendAudioChunk() {},
          close() {},
        };
      },
    },
    textGenerator: {
      async *streamText() {},
    },
    speechSynthesizer: {
      sampleRate: 16000,
      createStream() {
        return {
          async connect() {},
          sendText() {},
          async flush() {},
          close() {},
        };
      },
    },
  };
  return session;
}

class MockElement {
  textContent = "";
  hidden = false;
  children: MockElement[] = [];

  appendChild(child: MockElement) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: MockElement[]) {
    this.children = [...children];
  }
}

class MockButton extends MockElement {
  disabled = false;
  #listeners = new Map<string, () => void>();

  addEventListener(type: string, handler: () => void) {
    this.#listeners.set(type, handler);
  }

  click() {
    this.#listeners.get("click")?.();
  }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = "blob";
  sentPayloads: Array<string | ArrayBuffer> = [];
  #listeners = new Map<string, Array<{ handler: (event?: { data?: string }) => void; once: boolean }>>();

  constructor(public readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: (event?: { data?: string }) => void, options?: { once?: boolean }) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ handler, once: options?.once ?? false });
    this.#listeners.set(type, listeners);
  }

  send(payload: string | ArrayBuffer) {
    this.sentPayloads.push(payload);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  emit(type: string, event?: { data?: string }) {
    if (type === "open") {
      this.readyState = MockWebSocket.OPEN;
    }
    if (type === "error" || type === "close") {
      this.readyState = MockWebSocket.CLOSED;
    }

    const listeners = this.#listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener.handler(event);
    }

    this.#listeners.set(
      type,
      listeners.filter((listener) => !listener.once),
    );
  }

  emitMessage(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

class MockMediaStreamSource {
  connect() {}
  disconnect() {}
}

class MockAudioContext {
  sampleRate = 48_000;
  destination = {};
  audioWorklet = {
    addModule: vi.fn(async () => {}),
  };

  createMediaStreamSource() {
    return new MockMediaStreamSource();
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
    };
  }

  close() {
    return Promise.resolve();
  }
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    postMessage: vi.fn(),
  };

  connect() {}
  disconnect() {}
}

const sockets: MockWebSocket[] = [];

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  sockets.length = 0;
});

describe("SESS-03 websocket failure signalling", () => {
  it("SESS-03 accepts negotiated binary audio frames for the active session socket", async () => {
    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "session.start",
        sessionId: "tab-a",
        sampleRate: 48_000,
        audioFormat: {
          encoding: "pcm16",
          channels: 1,
        },
      }),
    );
    session.webSocketMessage(socket as unknown as WebSocket, new Int16Array([1, 2, 3]).buffer);
    await Promise.resolve();
    await Promise.resolve();

    expect(parseSentMessages(socket)[0]).toEqual({ type: "session.state", state: "connecting" });
    expect(session.lastAcceptedAudioChunkSequence).toBe(0);
  });

  it("ends an idle call after ten seconds without detected speech", async () => {
    vi.useFakeTimers();

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "session.start",
        sessionId: "tab-a",
        sampleRate: 48_000,
        audioFormat: {
          encoding: "pcm16",
          channels: 1,
        },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(parseSentMessages(socket)).toContainEqual({
      type: "session.closed",
      reason: "Call ended after 10 seconds of inactivity.",
    });
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "idle_timeout" }]);
    expect(session.activeSocket).toBeNull();
    expect(session.activeSessionId).toBeNull();
    expect(session.state).toBe("idle");
  });

  it("does not hang up while assistant playback is still active on the client", async () => {
    vi.useFakeTimers();

    const socket = new CapturingSocket();
    const session = (await createSession(socket as unknown as WebSocket)) as SessionDOProbe & {
      assistantPlaybackActive?: boolean;
      handleAssistantPlaybackEnded?: (assistantTurnId: number, clientTsMs?: number) => void;
    };

    session.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "session.start",
        sessionId: "tab-a",
        sampleRate: 48_000,
        audioFormat: {
          encoding: "pcm16",
          channels: 1,
        },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    (session as SessionDOProbe & { activeAssistantTurnId?: number }).activeAssistantTurnId = 1;
    session.assistantPlaybackActive = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(parseSentMessages(socket)).not.toContainEqual({
      type: "session.closed",
      reason: "Call ended after 10 seconds of inactivity.",
    });

    session.assistantPlaybackActive = false;
    session.handleAssistantPlaybackEnded?.(1);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(parseSentMessages(socket)).toContainEqual({
      type: "session.closed",
      reason: "Call ended after 10 seconds of inactivity.",
    });
  });

  it("SESS-03 reciprocates websocket close code and reason and clears active references", async () => {
    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    session.webSocketClose(socket as unknown as WebSocket, 1006, "network disconnect");
    const messages = parseSentMessages(socket);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      type: "session.error",
      code: "WS_DROPPED",
      message: "WebSocket connection dropped.",
    });
    expect(messages[1]).toEqual({
      type: "session.closed",
      reason: "network disconnect",
    });
    expect(socket.closeCalls).toEqual([{ code: 1006, reason: "network disconnect" }]);
    expect(session.activeSocket).toBeNull();
    expect(session.activeSessionId).toBeNull();
    expect(session.state).toBe("idle");
  });

  it("SESS-03 shows explicit retry guidance when the realtime websocket drops after startup", async () => {
    const startButton = new MockButton();
    const endButton = new MockButton();
    const statusElement = new MockElement();
    const errorElement = new MockElement();
    const transcriptList = new MockElement();
    const transcriptEmpty = new MockElement();
    const body = new MockElement();

    vi.stubGlobal("HTMLElement", MockElement);
    vi.stubGlobal("HTMLButtonElement", MockButton);
    vi.stubGlobal("HTMLCanvasElement", MockElement);
    vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" } });
    vi.stubGlobal("document", {
      body,
      querySelector(selector: string) {
        if (selector === "#start-session-btn") return startButton;
        if (selector === "#end-session-btn") return endButton;
        if (selector === "#session-status") return statusElement;
        if (selector === "#session-error") return errorElement;
        if (selector === "#transcript-list") return transcriptList;
        if (selector === "#transcript-empty") return transcriptEmpty;
        return null;
      },
      createElement() {
        return new MockElement();
      },
      addEventListener() {},
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(() =>
          Promise.resolve({
            getTracks: () => [{ stop: vi.fn() }],
          }),
        ),
      },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    await import("../../src/web/app.js");

    startButton.click();
    await flush();
    sockets[0]?.emit("open");
    sockets[0]?.emitMessage({ type: "session.state", state: "listening" });
    await flush();
    sockets[0]?.emit("close");
    await flush();

    expect(statusElement.textContent).toBe("error");
    expect(errorElement.textContent).toBe("Realtime connection dropped. Click Start Session to retry.");
  });

  it("shows a clean ended-call message when the server closes the session intentionally", async () => {
    const startButton = new MockButton();
    const endButton = new MockButton();
    const statusElement = new MockElement();
    const errorElement = new MockElement();
    const transcriptList = new MockElement();
    const transcriptEmpty = new MockElement();
    const body = new MockElement();

    vi.stubGlobal("HTMLElement", MockElement);
    vi.stubGlobal("HTMLButtonElement", MockButton);
    vi.stubGlobal("HTMLCanvasElement", MockElement);
    vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" } });
    vi.stubGlobal("document", {
      body,
      querySelector(selector: string) {
        if (selector === "#start-session-btn") return startButton;
        if (selector === "#end-session-btn") return endButton;
        if (selector === "#session-status") return statusElement;
        if (selector === "#session-error") return errorElement;
        if (selector === "#transcript-list") return transcriptList;
        if (selector === "#transcript-empty") return transcriptEmpty;
        return null;
      },
      createElement() {
        return new MockElement();
      },
      addEventListener() {},
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(() =>
          Promise.resolve({
            getTracks: () => [{ stop: vi.fn() }],
          }),
        ),
      },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    await import("../../src/web/app.js");

    startButton.click();
    await flush();
    sockets[0]?.emit("open");
    sockets[0]?.emitMessage({ type: "session.state", state: "listening" });
    await flush();
    sockets[0]?.emitMessage({ type: "session.closed", reason: "Call ended after 10 seconds of inactivity." });
    await flush();

    expect(statusElement.textContent).toBe("idle");
    expect(errorElement.textContent).toBe("Call ended after 10 seconds of inactivity.");
  });

  it("SESS-03 emits WS_CONNECT_FAILED on websocket error and clears active references", async () => {
    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket);

    session.webSocketError(socket as unknown as WebSocket, new Error("Connection setup failed"));
    const messages = parseSentMessages(socket);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      type: "session.error",
      code: "WS_CONNECT_FAILED",
      message: "Connection setup failed",
    });
    expect(session.activeSocket).toBeNull();
    expect(session.activeSessionId).toBeNull();
    expect(session.state).toBe("idle");
  });
});
