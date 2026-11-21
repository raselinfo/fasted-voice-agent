import { afterEach, describe, expect, it, vi } from "vitest";

import { __test__, ElevenLabsMultiContextSocket, ElevenLabsTtsStream } from "../../src/adapters/elevenlabs";

class MockWebSocket {
  readonly sentPayloads: string[] = [];
  #listeners = new Map<string, Array<(event?: unknown) => void>>();

  accept(): void {}

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(handler);
    this.#listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }

  close(): void {
    this.emit("close");
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function lastJson(socket: MockWebSocket): Record<string, unknown> {
  return JSON.parse(socket.sentPayloads.at(-1) ?? "{}") as Record<string, unknown>;
}

function pcmBase64(samples: number[]): string {
  return Buffer.from(new Int16Array(samples).buffer).toString("base64");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ElevenLabs multi-context socket", () => {
  it("detects the first speech offset in PCM16 audio", () => {
    const pcm = new Uint8Array([
      0x00, 0x00,
      0x10, 0x00,
      0x20, 0x00,
      0x01, 0x01,
    ]);

    expect(__test__.findLeadingSpeechOffset(pcm, 256)).toBe(6);
    expect(__test__.findLeadingSpeechOffset(new Uint8Array([0x00, 0x00, 0x10, 0x00]), 256)).toBeNull();
  });

  it("reuses one websocket across multiple per-turn TTS contexts", async () => {
    const socket = new MockWebSocket();
    const fetchMock = vi.fn(async () => ({ webSocket: socket }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const manager = new ElevenLabsMultiContextSocket({
      voiceId: "voice-id",
      apiKey: "api-key",
    });

    const firstChunks: Uint8Array[] = [];
    const firstStream = new ElevenLabsTtsStream(manager, {
      voiceId: "voice-id",
      apiKey: "api-key",
      onAudioChunk: (chunk) => firstChunks.push(chunk),
    });
    await manager.connect();
    await firstStream.connect();
    firstStream.sendText("Hello there.");
    const firstContextId = String(lastJson(socket).context_id);
    const firstFlush = firstStream.flush();
    socket.emit("message", {
      data: JSON.stringify({
        contextId: firstContextId,
        audio: pcmBase64([257, 258, 259]),
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        contextId: firstContextId,
        isFinal: true,
      }),
    });
    await firstFlush;
    firstStream.close();

    const secondChunks: Uint8Array[] = [];
    const secondStream = new ElevenLabsTtsStream(manager, {
      voiceId: "voice-id",
      apiKey: "api-key",
      onAudioChunk: (chunk) => secondChunks.push(chunk),
    });
    await secondStream.connect();
    secondStream.sendText("Second turn.");
    const secondContextId = String(lastJson(socket).context_id);
    const secondFlush = secondStream.flush();
    socket.emit("message", {
      data: JSON.stringify({
        contextId: secondContextId,
        audio: pcmBase64([300, 301]),
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        contextId: secondContextId,
        isFinal: true,
      }),
    });
    await secondFlush;
    secondStream.close();
    manager.closeSocket();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstContextId).not.toBe(secondContextId);
    expect(firstChunks[0]).toEqual(new Uint8Array(Buffer.from(new Int16Array([257, 258, 259]).buffer)));
    expect(secondChunks[0]).toEqual(new Uint8Array(Buffer.from(new Int16Array([300, 301]).buffer)));
    expect(socket.sentPayloads.some((payload) => payload.includes("\"close_context\":true"))).toBe(true);
    expect(socket.sentPayloads.at(-1)).toContain("\"close_socket\":true");
  });

  it("settles a flushed context after the audio stream goes idle even if isFinal never arrives", async () => {
    vi.useFakeTimers();

    const socket = new MockWebSocket();
    vi.stubGlobal("fetch", vi.fn(async () => ({ webSocket: socket }) as unknown as Response));

    const manager = new ElevenLabsMultiContextSocket({
      voiceId: "voice-id",
      apiKey: "api-key",
    });

    const chunks: Uint8Array[] = [];
    const stream = new ElevenLabsTtsStream(manager, {
      voiceId: "voice-id",
      apiKey: "api-key",
      onAudioChunk: (chunk) => chunks.push(chunk),
    });

    await stream.connect();
    stream.sendText("Boo.");
    const contextId = String(lastJson(socket).context_id);
    const flushed = stream.flush();

    socket.emit("message", {
      data: JSON.stringify({
        contextId,
        audio: pcmBase64([257, 258, 259]),
      }),
    });

    await vi.advanceTimersByTimeAsync(300);
    await expect(flushed).resolves.toBeUndefined();
    expect(chunks[0]).toEqual(new Uint8Array(Buffer.from(new Int16Array([257, 258, 259]).buffer)));
  });

  it("trims the leading quiet segment once before forwarding ElevenLabs PCM", async () => {
    const socket = new MockWebSocket();
    vi.stubGlobal("fetch", vi.fn(async () => ({ webSocket: socket }) as unknown as Response));

    const manager = new ElevenLabsMultiContextSocket({
      voiceId: "voice-id",
      apiKey: "api-key",
    });

    const chunks: Uint8Array[] = [];
    const stream = new ElevenLabsTtsStream(manager, {
      voiceId: "voice-id",
      apiKey: "api-key",
      onAudioChunk: (chunk) => chunks.push(chunk),
    });

    await stream.connect();
    stream.sendText("Trim me.");
    const contextId = String(lastJson(socket).context_id);
    const flushed = stream.flush();

    socket.emit("message", {
      data: JSON.stringify({
        contextId,
        audio: Buffer.from([
          0x00, 0x00,
          0x10, 0x00,
          0x20, 0x00,
          0x01, 0x01,
          0x02, 0x01,
        ]).toString("base64"),
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        contextId,
        audio: Buffer.from([
          0x03, 0x01,
          0x04, 0x01,
        ]).toString("base64"),
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        contextId,
        isFinal: true,
      }),
    });

    await flushed;

    expect(chunks).toEqual([
      new Uint8Array([0x01, 0x01, 0x02, 0x01]),
      new Uint8Array([0x03, 0x01, 0x04, 0x01]),
    ]);
  });
});
