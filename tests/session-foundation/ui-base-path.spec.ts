import { afterEach, describe, expect, it, vi } from "vitest";

class MockElement {
  textContent = "";
  children: MockElement[] = [];

  appendChild(child: MockElement) {
    this.children.push(child);
    return child;
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
  sentPayloads: string[] = [];
  url: string;
  #listeners = new Map<string, Array<{ handler: (event?: { data?: string }) => void; once: boolean }>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: string, handler: (event?: { data?: string }) => void, options?: { once?: boolean }) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ handler, once: options?.once ?? false });
    this.#listeners.set(type, listeners);
  }

  send(payload: string) {
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
}

class MockGainNode {
  gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
  };

  connect() {}

  disconnect() {}
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  sampleRate = 48_000;
  currentTime = 0;
  destination = {};
  audioWorklet = {
    addModule: vi.fn(async () => {}),
  };

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return new MockMediaStreamSource();
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
    };
  }

  createGain() {
    return new MockGainNode();
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
  MockAudioContext.instances.length = 0;
});

describe("UI base path", () => {
  it("uses APP_BASE_PATH for websocket and worklet URLs", async () => {
    const startButton = new MockButton();
    const endButton = new MockButton();
    const statusElement = new MockElement();
    const errorElement = new MockElement();
    const body = new MockElement();
    let resolveMic: (() => void) | undefined;

    const getUserMediaMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMic = () =>
            resolve({
              getTracks: () => [{ stop: vi.fn() }],
            });
        }),
    );

    vi.stubGlobal("HTMLElement", MockElement);
    vi.stubGlobal("HTMLButtonElement", MockButton);
    vi.stubGlobal("HTMLCanvasElement", MockElement);
    const vadInstance = {
      start: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    };
    const vadNewMock = vi.fn(async (options) => Object.assign(vadInstance, { options }));
    vi.stubGlobal("window", {
      __APP_BASE_PATH__: "/voice-agent",
      vad: {
        MicVAD: {
          new: vadNewMock,
        },
      },
      location: { protocol: "https:", host: "example.com", pathname: "/voice-agent/" },
    });
    vi.stubGlobal("document", {
      body,
      querySelector(selector: string) {
        if (selector === "#start-session-btn") {
          return startButton;
        }
        if (selector === "#end-session-btn") {
          return endButton;
        }
        if (selector === "#session-status") {
          return statusElement;
        }
        if (selector === "#session-error") {
          return errorElement;
        }
        return null;
      },
      createElement() {
        return new MockElement();
      },
      addEventListener() {},
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: getUserMediaMock,
      },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    vi.resetModules();
    await import("../../src/web/app.js");

    startButton.click();
    resolveMic?.();
    await flush();
    sockets[0]?.emit("open");
    await flush();
    sockets[0]?.emitMessage({ type: "session.state", state: "listening" });
    await flush();

    expect(MockAudioContext.instances[0]?.audioWorklet.addModule).toHaveBeenCalledWith("/voice-agent/audio-worklet.js");
    expect(sockets[0]?.url).toBe("wss://example.com/voice-agent/api/session?sessionId=11111111-1111-4111-8111-111111111111");
    expect(vadNewMock).toHaveBeenCalledTimes(1);
    expect(vadNewMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        baseAssetPath: "/voice-agent/vendor/vad/",
        onnxWASMBasePath: "/voice-agent/vendor/ort/",
      }),
    );
  });
});
