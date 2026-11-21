const PCM16_SCALE = 32768;

function clampPcm16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

export function applyPcm16Gain(chunk: Uint8Array, gainDb: number): Uint8Array {
  if (!Number.isFinite(gainDb) || Math.abs(gainDb) < 0.001 || chunk.byteLength === 0) {
    return chunk;
  }

  const gain = 10 ** (gainDb / 20);
  const input = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const output = new Uint8Array(chunk.byteLength);
  const outputView = new DataView(output.buffer);

  for (let offset = 0; offset + 1 < chunk.byteLength; offset += 2) {
    const sample = input.getInt16(offset, true) / PCM16_SCALE;
    outputView.setInt16(offset, clampPcm16(sample * gain * PCM16_SCALE), true);
  }

  return output;
}

export class Pcm16GainProcessor {
  private readonly gainDb: number;
  private carryByte: number | null = null;

  constructor(gainDb: number) {
    this.gainDb = gainDb;
  }

  process(chunk: Uint8Array): Uint8Array {
    if (chunk.byteLength === 0) {
      return chunk;
    }

    let input = chunk;
    if (this.carryByte !== null) {
      const merged = new Uint8Array(chunk.byteLength + 1);
      merged[0] = this.carryByte;
      merged.set(chunk, 1);
      input = merged;
      this.carryByte = null;
    }

    const evenByteLength = input.byteLength - (input.byteLength % 2);
    if (evenByteLength === 0) {
      this.carryByte = input[0] ?? null;
      return new Uint8Array(0);
    }

    if (evenByteLength < input.byteLength) {
      this.carryByte = input[input.byteLength - 1] ?? null;
    }

    return applyPcm16Gain(input.subarray(0, evenByteLength), this.gainDb);
  }
}
