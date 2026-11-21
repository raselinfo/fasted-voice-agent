import { afterEach, describe, expect, it, vi } from "vitest";

class MockElement {
  textContent = "";
  hidden = false;
  children: MockElement[] = [];
  attributes = new Map<string, string>();

  appendChild(child: MockElement) {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

class MockButton extends MockElement {
  disabled = false;
  #listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, handler: () => void) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(handler);
    this.#listeners.set(type, listeners);
  }

  click() {
    for (const handler of this.#listeners.get("click") ?? []) {
      handler();
    }
  }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sentPayloads: string[] = [];
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

async function setupApp() {
  const startButton = new MockButton();
  const endButton = new MockButton();
  const statusElement = new MockElement();
  const errorElement = new MockElement();
  const transcriptPanel = new MockElement();
  const transcriptList = new MockElement();
  const transcriptEmpty = new MockElement();

  vi.stubGlobal("HTMLElement", MockElement);
  vi.stubGlobal("HTMLButtonElement", MockButton);
  vi.stubGlobal("HTMLCanvasElement", MockElement);
  vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" } });
  vi.stubGlobal("document", {
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
      if (selector === "#transcript-panel") {
        return transcriptPanel;
      }
      if (selector === "#transcript-list") {
        return transcriptList;
      }
      if (selector === "#transcript-empty") {
        return transcriptEmpty;
      }
      return null;
    },
    createElement() {
      return new MockElement();
    },
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

  vi.resetModules();
  await import("../../src/web/app.js");

  return { startButton, transcriptList, transcriptEmpty };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  sockets.length = 0;
});

describe("Phase 2 transcript UI", () => {
  it("UI-04 appends finalized transcript rows with stable data-turn-id attributes", async () => {
    const harness = await setupApp();

    expect(harness.transcriptEmpty.hidden).toBe(false);

    harness.startButton.click();
    await flush();
    sockets[0]?.emit("open");
    sockets[0]?.emitMessage({ type: "session.state", state: "listening" });
    await flush();

    sockets[0]?.emitMessage({ type: "session.state", state: "thinking" });
    sockets[0]?.emitMessage({ type: "turn.user.final", turnId: 1, text: "Hello there" });
    sockets[0]?.emitMessage({ type: "turn.interrupted", assistantTurnId: 1, reason: "client_hint" });
    sockets[0]?.emitMessage({ type: "turn.assistant.final", assistantTurnId: 1, text: "Hi back" });
    await flush();

    expect(harness.transcriptList.children).toHaveLength(2);
    expect(harness.transcriptEmpty.hidden).toBe(true);
    expect(harness.transcriptList.children[0]?.textContent).toBe("Hello there");
    expect(harness.transcriptList.children[0]?.getAttribute("data-role")).toBe("user");
    expect(harness.transcriptList.children[0]?.getAttribute("data-turn-id")).toBe("1");
    expect(harness.transcriptList.children[1]?.textContent).toBe("Hi back");
    expect(harness.transcriptList.children[1]?.getAttribute("data-role")).toBe("assistant");
    expect(harness.transcriptList.children[1]?.getAttribute("data-turn-id")).toBe("1");
  });
});
