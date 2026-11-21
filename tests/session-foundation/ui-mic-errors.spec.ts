import { afterEach, describe, expect, it, vi } from "vitest";

class MockElement {
  textContent = "";
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
  url: string;
  #listeners = new Map<string, Array<{ handler: () => void; once: boolean }>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: string, handler: () => void, options?: { once?: boolean }) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ handler, once: options?.once ?? false });
    this.#listeners.set(type, listeners);
  }

  send() {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  emit(type: string) {
    if (type === "open") {
      this.readyState = MockWebSocket.OPEN;
    }
    if (type === "error" || type === "close") {
      this.readyState = MockWebSocket.CLOSED;
    }

    const listeners = this.#listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener.handler();
    }
    this.#listeners.set(
      type,
      listeners.filter((listener) => !listener.once),
    );
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

type SetupOptions = {
  getUserMediaImpl: () => Promise<unknown>;
};

async function setupApp(options: SetupOptions) {
  sockets.length = 0;
  const startButton = new MockButton();
  const statusElement = new MockElement();
  const errorElement = new MockElement();
  const getUserMediaMock = vi.fn(options.getUserMediaImpl);

  vi.stubGlobal("HTMLElement", MockElement);
  vi.stubGlobal("HTMLButtonElement", MockButton);
  vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" } });
  vi.stubGlobal("document", {
    querySelector(selector: string) {
      if (selector === "#start-session-btn") {
        return startButton;
      }
      if (selector === "#session-status") {
        return statusElement;
      }
      if (selector === "#session-error") {
        return errorElement;
      }
      return null;
    },
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

  return { startButton, statusElement, errorElement, getUserMediaMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  sockets.length = 0;
});

describe("UI-02 microphone and startup errors", () => {
  it("UI-02 maps NotAllowedError to the explicit denied-microphone message", async () => {
    const harness = await setupApp({
      getUserMediaImpl: () => Promise.reject({ name: "NotAllowedError" }),
    });

    harness.startButton.click();
    await flush();

    expect(harness.statusElement.textContent).toBe("Status: error");
    expect(harness.errorElement.textContent).toBe("Microphone access denied. Allow microphone and try again.");
  });

  it("UI-02 maps NotFoundError to the explicit missing-microphone message", async () => {
    const harness = await setupApp({
      getUserMediaImpl: () => Promise.reject({ name: "NotFoundError" }),
    });

    harness.startButton.click();
    await flush();

    expect(harness.statusElement.textContent).toBe("Status: error");
    expect(harness.errorElement.textContent).toBe("No microphone detected. Connect a microphone and try again.");
  });

  it("UI-02 maps websocket startup failure to manual retry guidance without auto-retry", async () => {
    const harness = await setupApp({
      getUserMediaImpl: () =>
        Promise.resolve({
          getTracks: () => [{ stop: vi.fn() }],
        }),
    });

    harness.startButton.click();
    await flush();
    expect(sockets).toHaveLength(1);

    sockets[0]?.emit("error");
    await flush();

    expect(harness.statusElement.textContent).toBe("Status: error");
    expect(harness.errorElement.textContent).toBe(
      "Could not connect to realtime session. Click Start Session to retry.",
    );

    await flush();
    expect(harness.getUserMediaMock).toHaveBeenCalledTimes(1);

    harness.startButton.click();
    await flush();
    expect(harness.getUserMediaMock).toHaveBeenCalledTimes(2);
  });

  it("UI-02 maps generic microphone errors to the explicit fallback startup-failure message", async () => {
    const harness = await setupApp({
      getUserMediaImpl: () => Promise.reject({ name: "NotReadableError" }),
    });

    harness.startButton.click();
    await flush();

    expect(harness.statusElement.textContent).toBe("Status: error");
    expect(harness.errorElement.textContent).toBe("Microphone startup failed. Try again.");
  });
});
