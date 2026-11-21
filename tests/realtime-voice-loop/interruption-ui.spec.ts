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

  emitJson(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  emitBinary(buffer: ArrayBuffer) {
    this.emit("message", { data: buffer });
  }
}

class MockMediaStreamSource {
  connect() {}
  disconnect() {}
}

class MockGainNode {
  gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn((value: number) => {
      this.gain.value = value;
    }),
    setValueAtTime: vi.fn((value: number) => {
      this.gain.value = value;
    }),
  };

  connect() {}

  disconnect() {}
}

class MockAudioContext {
  sampleRate = 48_000;
  currentTime = 0;
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

  createGain() {
    const node = new MockGainNode();
    gainNodes.push(node);
    return node;
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
const gainNodes: MockGainNode[] = [];

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

async function setupApp() {
  const startButton = new MockButton();
  const endButton = new MockButton();
  const statusElement = new MockElement();
  const errorElement = new MockElement();
  const transcriptList = new MockElement();
  const transcriptEmpty = new MockElement();
  const vadInstance = {
    start: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };
  const vadNewMock = vi.fn(async (options) => Object.assign(vadInstance, { options }));

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

  return { startButton, statusElement, vadNewMock, vadInstance };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  sockets.length = 0;
  workletNodes.length = 0;
  gainNodes.length = 0;
});

describe("Phase 2 interruption UX", () => {
  it("TURN-04 and INTR-01 use confirmed VAD speech to emit one client.interrupt hint per segment", async () => {
    const harness = await setupApp();

    harness.startButton.click();
    await flush();
    sockets[0]?.emit("open");
    sockets[0]?.emitJson({ type: "session.state", state: "listening" });
    await flush();

    const captureNode = workletNodes.find((node) => node.name === "pcm-capture-processor");
    const playbackNode = workletNodes.find((node) => node.name === "pcm-playback-processor");

    sockets[0]?.emitJson({
      type: "turn.assistant.audio.start",
      assistantTurnId: 1,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });
    sockets[0]?.emitBinary(new Int16Array([0, 1024, -1024]).buffer);
    await flush();

    expect(playbackNode?.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueue",
        buffer: expect.any(ArrayBuffer),
      }),
      expect.any(Array),
    );

    expect(captureNode).toBeDefined();
    expect(harness.vadNewMock).toHaveBeenCalledTimes(1);
    await harness.vadNewMock.mock.calls[0][0].onSpeechRealStart();
    await flush();

    const jsonPayloads = sockets[0]?.sentPayloads.filter((payload): payload is string => typeof payload === "string") ?? [];
    expect(jsonPayloads.filter((payload) => payload.includes('"type":"client.interrupt"'))).toHaveLength(1);
    expect(playbackNode?.port.postMessage).toHaveBeenCalledWith({ type: "clear" });
    expect(harness.statusElement.textContent).toBe("interrupted");
  });

  it("ducks local playback on mic energy without sending an authoritative interrupt", async () => {
    const harness = await setupApp();

    harness.startButton.click();
    await flush();

    const socket = sockets[0];
    const captureNode = workletNodes.find((node) => node.name === "pcm-capture-processor");
    const gainNode = gainNodes[0];

    if (!socket || !captureNode || !gainNode) {
      throw new Error("Expected websocket, capture node, and playback gain node.");
    }

    socket.emit("open");
    socket.emitJson({ type: "session.state", state: "listening" });
    await flush();

    socket.emitJson({
      type: "turn.assistant.audio.start",
      assistantTurnId: 1,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });
    await flush();

    captureNode.emit({
      type: "capture",
      sampleRate: 48_000,
      buffer: new Int16Array([0, 8192, -8192, 4096]).buffer,
    });
    await flush();

    expect(gainNode.gain.setTargetAtTime).toHaveBeenCalledWith(0.4, 0, 0.02);

    captureNode.emit({
      type: "capture",
      sampleRate: 48_000,
      buffer: new Int16Array([0, 128, -128, 64]).buffer,
    });
    await flush();

    expect(gainNode.gain.setTargetAtTime).toHaveBeenCalledWith(1, 0, 0.08);

    const jsonPayloads = socket.sentPayloads.filter((payload): payload is string => typeof payload === "string");
    expect(jsonPayloads.filter((payload) => payload.includes('"type":"client.interrupt"'))).toHaveLength(0);
  });

  it("LAT-04 reports playback start even if audio.end arrives before the worklet starts consuming audio", async () => {
    const harness = await setupApp();

    harness.startButton.click();
    await flush();

    const socket = sockets[0];
    const playbackNode = workletNodes.find((node) => node.name === "pcm-playback-processor");

    if (!socket || !playbackNode) {
      throw new Error("Expected websocket and playback node.");
    }

    socket.emit("open");
    socket.emitJson({ type: "session.state", state: "listening" });
    await flush();

    socket.emitJson({
      type: "turn.assistant.audio.start",
      assistantTurnId: 7,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });
    socket.emitBinary(new Int16Array([0, 2048, -2048]).buffer);
    socket.emitJson({
      type: "turn.assistant.audio.end",
      assistantTurnId: 7,
      isFinal: true,
    });
    await flush();

    playbackNode.emit({ type: "playback_started" });
    await flush();

    const jsonPayloads = socket.sentPayloads
      .filter((payload): payload is string => typeof payload === "string")
      .map((payload) => JSON.parse(payload));
    expect(jsonPayloads).toContainEqual(
      expect.objectContaining({
        type: "turn.assistant.playback.started",
        assistantTurnId: 7,
      }),
    );
  });

  it("LAT-05 reports playback end once both drain and the final audio marker have been observed", async () => {
    const harness = await setupApp();

    harness.startButton.click();
    await flush();

    const socket = sockets[0];
    const playbackNode = workletNodes.find((node) => node.name === "pcm-playback-processor");

    if (!socket || !playbackNode) {
      throw new Error("Expected websocket and playback node.");
    }

    socket.emit("open");
    socket.emitJson({ type: "session.state", state: "listening" });
    await flush();

    socket.emitJson({
      type: "turn.assistant.audio.start",
      assistantTurnId: 8,
      sampleRate: 16000,
      encoding: "pcm16",
      channels: 1,
    });
    socket.emitBinary(new Int16Array([0, 2048, -2048]).buffer);
    await flush();

    playbackNode.emit({ type: "drained" });
    await flush();

    let jsonPayloads = socket.sentPayloads
      .filter((payload): payload is string => typeof payload === "string")
      .map((payload) => JSON.parse(payload));
    expect(jsonPayloads).not.toContainEqual(
      expect.objectContaining({
        type: "turn.assistant.playback.ended",
        assistantTurnId: 8,
      }),
    );

    socket.emitJson({
      type: "turn.assistant.audio.end",
      assistantTurnId: 8,
      isFinal: true,
    });
    await flush();

    jsonPayloads = socket.sentPayloads
      .filter((payload): payload is string => typeof payload === "string")
      .map((payload) => JSON.parse(payload));
    expect(jsonPayloads).toContainEqual(
      expect.objectContaining({
        type: "turn.assistant.playback.ended",
        assistantTurnId: 8,
      }),
    );
  });
});
