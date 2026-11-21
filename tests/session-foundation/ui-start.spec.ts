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

describe("UI-01 startup path", () => {
  it("UI-01 queries the expected startup/status/error DOM surfaces and keeps one clear start action", async () => {
    const requestedSelectors: string[] = [];
    const startButton = new MockButton();
    const endButton = new MockButton();
    const statusElement = new MockElement();
    const errorElement = new MockElement();
    const body = new MockElement();

    vi.stubGlobal("HTMLElement", MockElement);
    vi.stubGlobal("HTMLButtonElement", MockButton);
    vi.stubGlobal("HTMLCanvasElement", MockElement);
    vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" } });
    vi.stubGlobal("document", {
      body,
      querySelector(selector: string) {
        requestedSelectors.push(selector);
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
        getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] })),
      },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    vi.resetModules();
    await import("../../src/web/app.js");

    expect(requestedSelectors).toContain("#start-session-btn");
    expect(requestedSelectors).toContain("#end-session-btn");
    expect(requestedSelectors).toContain("#session-status");
    expect(requestedSelectors).toContain("#session-error");
  });

  it("UI-01 starts microphone capture and websocket startup from first click and sends session.start", async () => {
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
    vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" } });
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
    expect(statusElement.textContent).toBe("requesting_mic");

    resolveMic?.();
    await flush();
    expect(statusElement.textContent).toBe("connecting");
    expect(getUserMediaMock).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    sockets[0]?.emit("open");
    await flush();

    expect(statusElement.textContent).toBe("connecting");

    sockets[0]?.emitMessage({ type: "session.state", state: "listening" });
    await flush();

    expect(statusElement.textContent).toBe("listening");
    expect(sockets[0]?.url).toBe("wss://example.com/api/session?sessionId=11111111-1111-4111-8111-111111111111");
    expect(sockets[0]?.sentPayloads).toEqual([
      JSON.stringify({
        type: "session.start",
        sessionId: "11111111-1111-4111-8111-111111111111",
        sampleRate: 48_000,
        audioFormat: {
          encoding: "pcm16",
          channels: 1,
        },
        scenario: "drive-thru",
        ttsConfig: {
          provider: "together-orpheus",
          model: "canopylabs/orpheus-3b-0.1-ft",
        },
      }),
    ]);
  });

  it("creates one shared-stream MicVAD sidecar after session readiness and tears it down with the audio context", async () => {
    const startButton = new MockButton();
    const endButton = new MockButton();
    const statusElement = new MockElement();
    const errorElement = new MockElement();
    const body = new MockElement();
    const mediaStream = {
      getTracks: () => [{ stop: vi.fn() }],
    };
    const lifecycleEvents: string[] = [];
    const vadInstance = {
      start: vi.fn(async () => {
        lifecycleEvents.push("vad.start");
      }),
      destroy: vi.fn(async () => {
        lifecycleEvents.push("vad.destroy");
      }),
    };
    const vadNewMock = vi.fn(async (options) => {
      lifecycleEvents.push("vad.new");
      return Object.assign(vadInstance, { options });
    });

    vi.stubGlobal("HTMLElement", MockElement);
    vi.stubGlobal("HTMLButtonElement", MockButton);
    vi.stubGlobal("HTMLCanvasElement", MockElement);
    vi.stubGlobal("window", {
      location: { protocol: "https:", host: "example.com" },
      vad: {
        MicVAD: {
          new: vadNewMock,
        },
      },
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
        getUserMedia: vi.fn(async () => mediaStream),
      },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
    vi.spyOn(MockAudioContext.prototype, "close").mockImplementation(() => {
      lifecycleEvents.push("audioContext.close");
      return Promise.resolve();
    });
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    vi.resetModules();
    await import("../../src/web/app.js");

    startButton.click();
    await flush();

    expect(vadNewMock).not.toHaveBeenCalled();

    sockets[0]?.emit("open");
    await flush();

    expect(vadNewMock).not.toHaveBeenCalled();

    sockets[0]?.emitMessage({ type: "session.state", state: "listening" });
    await flush();

    expect(vadNewMock).toHaveBeenCalledTimes(1);
    const vadOptions = vadNewMock.mock.calls[0][0];
    expect(vadOptions.audioContext).toBe(MockAudioContext.instances[0]);
    expect(vadOptions.positiveSpeechThreshold).toBe(0.6);
    expect(vadOptions.minSpeechMs).toBe(700);
    expect(vadOptions.onSpeechRealStart).toBeTypeOf("function");
    await expect(vadOptions.getStream()).resolves.toBe(mediaStream);
    expect(vadInstance.start).toHaveBeenCalledTimes(1);

    endButton.click();
    await flush();

    expect(vadInstance.destroy).toHaveBeenCalledTimes(1);
    expect(lifecycleEvents.indexOf("vad.destroy")).toBeGreaterThan(-1);
    expect(lifecycleEvents.indexOf("audioContext.close")).toBeGreaterThan(lifecycleEvents.indexOf("vad.destroy"));
  });

  it("uses the configured app base path for websocket and worklet URLs", async () => {
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
    vi.stubGlobal("window", {
      __APP_BASE_PATH__: "/voice-agent",
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
    expect(sockets[0]?.url).toBe(
      "wss://example.com/voice-agent/api/session?sessionId=11111111-1111-4111-8111-111111111111",
    );
  });

  it("includes PostHog identity in session.start when browser analytics is available", async () => {
    const startButton = new MockButton();
    const endButton = new MockButton();
    const statusElement = new MockElement();
    const errorElement = new MockElement();
    const body = new MockElement();
    let resolveMic: (() => void) | undefined;
    const posthog = {
      capture: vi.fn(),
      get_distinct_id: vi.fn(() => "ph-distinct-id"),
      get_session_id: vi.fn(() => "ph-session-id"),
    };

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
    vi.stubGlobal("window", {
      __POSTHOG_CONFIG__: { appSurface: "voice-agent" },
      posthog,
      location: { protocol: "https:", host: "example.com", pathname: "/" },
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

    expect(sockets[0]?.sentPayloads.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "session.start",
        sessionId: "11111111-1111-4111-8111-111111111111",
        analytics: {
          distinctId: "ph-distinct-id",
          sessionId: "ph-session-id",
        },
        sampleRate: 48_000,
        audioFormat: {
          encoding: "pcm16",
          channels: 1,
        },
        scenario: "drive-thru",
        ttsConfig: {
          provider: "together-orpheus",
          model: "canopylabs/orpheus-3b-0.1-ft",
        },
      },
    ]);
    expect(posthog.capture).toHaveBeenCalledWith("voice_agent_page_viewed", {
      app_surface: "voice-agent",
      path: "/",
      app_base_path: "",
      posthog_session_id: "ph-session-id",
    });
    expect(posthog.capture).toHaveBeenCalledWith("voice_agent_call_start_clicked", {
      app_surface: "voice-agent",
      scenario: "drive-thru",
      tts_provider: "together-orpheus",
      tts_model: "canopylabs/orpheus-3b-0.1-ft",
      tts_voice: null,
    });
    expect(posthog.capture).toHaveBeenCalledWith("voice_agent_client_call_started", {
      app_surface: "voice-agent",
      call_session_id: "11111111-1111-4111-8111-111111111111",
      scenario: "drive-thru",
      tts_provider: "together-orpheus",
      tts_model: "canopylabs/orpheus-3b-0.1-ft",
      tts_voice: null,
      posthog_distinct_id: "ph-distinct-id",
      posthog_session_id: "ph-session-id",
    });
  });
});
