import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionStartMessageSchema } from "../../src/protocol/messages";

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
  binaryType = "blob";
  sentPayloads: Array<string | ArrayBuffer> = [];
  #listeners = new Map<string, Array<{ handler: (event?: { data?: unknown }) => void; once: boolean }>>();

  constructor(public readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: (event?: { data?: unknown }) => void, options?: { once?: boolean }) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ handler, once: options?.once ?? false });
    this.#listeners.set(type, listeners);
  }

  send(payload: string | ArrayBuffer) {
    this.sentPayloads.push(payload);
  }

  emit(type: string, event?: { data?: unknown }) {
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
  readonly port: {
    onmessage: null | ((event: { data: unknown }) => void);
    postMessage: ReturnType<typeof vi.fn>;
  };

  constructor(
    _context: MockAudioContext,
    public readonly name: string,
  ) {
    this.port = {
      onmessage: null,
      postMessage: vi.fn(),
    };
    workletNodes.push(this);
  }

  connect() {}
  disconnect() {}

  emit(data: unknown) {
    this.port.onmessage?.({ data });
  }
}

const sockets: MockWebSocket[] = [];
const workletNodes: MockAudioWorkletNode[] = [];

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  sockets.length = 0;
  workletNodes.length = 0;
});

describe("SESS-02 audio transport", () => {
  it("SESS-02 sends negotiated session.start and binary mic frames", async () => {
    const startButton = new MockButton();
    const endButton = new MockButton();
    const statusElement = new MockElement();
    const errorElement = new MockElement();
    const transcriptList = new MockElement();
    const transcriptEmpty = new MockElement();

    vi.stubGlobal("HTMLElement", MockElement);
    vi.stubGlobal("HTMLButtonElement", MockButton);
    vi.stubGlobal("HTMLCanvasElement", MockElement);
    vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" } });
    vi.stubGlobal("document", {
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

    expect(workletNodes.map((node) => node.name)).toEqual([
      "pcm-capture-processor",
      "pcm-playback-processor",
    ]);

    const sessionStart = sessionStartMessageSchema.parse(JSON.parse(String(sockets[0]?.sentPayloads[0])));
    expect(sessionStart).toEqual({
      type: "session.start",
      sessionId: "11111111-1111-4111-8111-111111111111",
      sampleRate: 48_000,
      audioFormat: {
        encoding: "pcm16",
        channels: 1,
      },
    });

    const pcmFrame = new Int16Array([0, 1024, -1024]).buffer;
    workletNodes[0]?.emit({
      type: "capture",
      sampleRate: 48_000,
      buffer: pcmFrame,
    });
    await flush();

    expect(sockets[0]?.binaryType).toBe("arraybuffer");
    expect(sockets[0]?.sentPayloads[1]).toBeInstanceOf(ArrayBuffer);
    expect(new Int16Array(sockets[0]?.sentPayloads[1] as ArrayBuffer)).toEqual(new Int16Array([0, 1024, -1024]));
  });
});
