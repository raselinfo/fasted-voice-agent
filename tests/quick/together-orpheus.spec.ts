import { afterEach, describe, expect, it, vi } from "vitest";

import { TogetherOrpheusTtsStream, __test__ } from "../../src/adapters/together-orpheus";

function createSseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
      },
    },
  );
}

describe("Together Orpheus adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses SSE chunks and decodes audio deltas", async () => {
    const onAudioChunk = vi.fn();
    const pcm = new Int16Array([0, 0, 0, 300, 301]);
    const fetchMock = vi.fn(async () =>
      createSseResponse([
        `data: {"type":"conversation.item.audio_output.delta","delta":"${Buffer.from(pcm.buffer).toString("base64")}"}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stream = new TogetherOrpheusTtsStream({
      apiKey: "together-key",
      onAudioChunk,
    });

    await stream.connect();
    stream.sendText("Hello there");
    await stream.flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.together.ai/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer together-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(onAudioChunk).toHaveBeenCalledWith(new Uint8Array(Buffer.from(new Int16Array([300, 301]).buffer)));
  });

  it("applies configured gain before forwarding PCM", async () => {
    const onAudioChunk = vi.fn();
    const pcm = new Int16Array([0, 0, 0, 600, 1200]);
    vi.stubGlobal("fetch", vi.fn(async () =>
      createSseResponse([
        `data: {"type":"conversation.item.audio_output.delta","delta":"${Buffer.from(pcm.buffer).toString("base64")}"}\n\n`,
        'data: [DONE]\n\n',
      ]),
    ));

    const stream = new TogetherOrpheusTtsStream({
      apiKey: "together-key",
      gainDb: -6,
      onAudioChunk,
    });

    await stream.connect();
    stream.sendText("Hello there");
    await stream.flush();

    expect(onAudioChunk).toHaveBeenCalledWith(new Uint8Array(Buffer.from(new Int16Array([301, 601]).buffer)));
  });

  it("fails clearly when Together rejects the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));

    const onError = vi.fn();
    const stream = new TogetherOrpheusTtsStream({
      apiKey: "bad-key",
      onAudioChunk: vi.fn(),
      onError,
    });

    await stream.connect();
    stream.sendText("Hello there");
    await expect(stream.flush()).rejects.toThrow("Together TTS request failed with status 401.");
    expect(onError).toHaveBeenCalled();
  });

  it("exposes the SSE parsing helpers for fragmented payloads", () => {
    expect(__test__.splitSseFrames('data: {"type":"x"}\n\ndata: [DONE]')).toEqual({
      frames: ['data: {"type":"x"}'],
      remainder: 'data: [DONE]',
    });
    expect(__test__.parseSseData('event: message\ndata: {"type":"x"}\ndata: [DONE]')).toEqual([
      '{"type":"x"}',
      '[DONE]',
    ]);
    expect(__test__.decodeBase64("AQID")).toEqual(new Uint8Array([1, 2, 3]));
    expect(__test__.findLeadingSpeechOffset(new Uint8Array(Buffer.from(new Int16Array([0, 0, 257]).buffer)), 256)).toBe(4);
  });
});
