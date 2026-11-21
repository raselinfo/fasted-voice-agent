import { describe, expect, it } from "vitest";

import { Pcm16GainProcessor, applyPcm16Gain } from "../../src/adapters/pcm-gain";

function readSamples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples: number[] = [];
  for (let offset = 0; offset + 1 < bytes.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}

describe("PCM gain helper", () => {
  it("applies gain in decibels to PCM16 samples", () => {
    const input = new Uint8Array(Buffer.from(new Int16Array([1000, -1000]).buffer));
    const gained = applyPcm16Gain(input, 6);

    expect(readSamples(gained)).toEqual([1995, -1995]);
  });

  it("clips samples at PCM16 bounds", () => {
    const input = new Uint8Array(Buffer.from(new Int16Array([30000, -30000]).buffer));
    const gained = applyPcm16Gain(input, 6);

    expect(readSamples(gained)).toEqual([32767, -32768]);
  });

  it("preserves sample boundaries across odd-byte chunk splits", () => {
    const processor = new Pcm16GainProcessor(6);
    const source = new Uint8Array(Buffer.from(new Int16Array([1000, -1000, 500]).buffer));

    const first = processor.process(source.subarray(0, 3));
    const second = processor.process(source.subarray(3));

    expect(readSamples(first)).toEqual([1995]);
    expect(readSamples(second)).toEqual([-1995, 998]);
  });
});
