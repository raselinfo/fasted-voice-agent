import { describe, expect, it, vi } from "vitest";

import { WorkersAiAuraTtsStream, __test__ } from "../../src/adapters/workers-ai-aura";

function createTestWav(pcmBytes: Uint8Array): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  header.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  header.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt 
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set([0x64, 0x61, 0x74, 0x61], 36); // data
  view.setUint32(40, pcmBytes.byteLength, true);

  const wav = new Uint8Array(header.byteLength + pcmBytes.byteLength);
  wav.set(header, 0);
  wav.set(pcmBytes, header.byteLength);
  return wav;
}

describe("Workers AI Aura adapter", () => {
  it("strips the WAV container and yields PCM bytes across split chunks", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = createTestWav(pcm);
    const state = { pending: new Uint8Array(0), dataOffset: null as number | null };

    const first = __test__.takePcmChunk(state, wav.slice(0, 20));
    const second = __test__.takePcmChunk(state, wav.slice(20, 46));
    const third = __test__.takePcmChunk(state, wav.slice(46));

    expect(first).toBeNull();
    expect(second).toEqual(new Uint8Array([1, 2]));
    expect(third).toEqual(new Uint8Array([3, 4, 5, 6, 7, 8]));
    expect(__test__.parseWavDataOffset(wav)).toBe(44);
  });

  it("keeps PCM16 samples aligned when audio bytes arrive on odd chunk boundaries", () => {
    const processor = new __test__.Pcm16GainProcessor(6);
    const pcm = new Uint8Array(Buffer.from(new Int16Array([1000, -1000, 500]).buffer));

    const first = processor.process(pcm.subarray(0, 3));
    const second = processor.process(pcm.subarray(3));

    expect(new Int16Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength))).toEqual(
      new Int16Array([1995]),
    );
    expect(new Int16Array(second.buffer.slice(second.byteOffset, second.byteOffset + second.byteLength))).toEqual(
      new Int16Array([-1995, 998]),
    );
  });

  it("trims the leading quiet segment once before forwarding Aura PCM", async () => {
    const onAudioChunk = vi.fn();
    const wav = createTestWav(
      new Uint8Array(
        Buffer.from(
          new Int16Array([
            0,
            16,
            32,
            257,
            258,
            259,
            260,
          ]).buffer,
        ),
      ),
    );

    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(wav.slice(0, 46));
          controller.enqueue(wav.slice(46, 49));
          controller.enqueue(wav.slice(49));
          controller.close();
        },
      }),
    );

    const stream = new WorkersAiAuraTtsStream({
      ai: {
        run: vi.fn(async () => response),
      },
      onAudioChunk,
    });

    await stream.connect();
    stream.sendText("Trim me.");
    await stream.flush();

    expect(onAudioChunk.mock.calls).toEqual([
      [new Uint8Array(Buffer.from(new Int16Array([257, 258, 259, 260]).buffer))],
    ]);
  });
});
