import { describe, expect, it } from "vitest";

const audioAnalysisModulePath = "../../scripts/provider-bench/audio-analysis.mjs";
const {
  analyzePcm16Mono,
  createPcm16Wav,
  extractWavPcm16,
} = await import(audioAnalysisModulePath);

function pcmBytesFromSamples(samples: number[]): Uint8Array {
  return new Uint8Array(Buffer.from(new Int16Array(samples).buffer));
}

function repeatedSamples(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

describe("provider bench audio analysis", () => {
  it("extracts mono PCM16 from a WAV payload", () => {
    const pcmBytes = pcmBytesFromSamples([0, 256, -256, 1024]);
    const wavBytes = createPcm16Wav(pcmBytes, 16000);

    const extracted = extractWavPcm16(wavBytes);

    expect(extracted.sampleRate).toBe(16000);
    expect(extracted.channels).toBe(1);
    expect(extracted.pcmBytes).toEqual(pcmBytes);
  });

  it("keeps leading silence stable while reflecting gain differences in speech RMS", () => {
    const loudSamples = [
      ...repeatedSamples(0, 40),
      ...repeatedSamples(4000, 60),
    ];
    const quietSamples = [
      ...repeatedSamples(0, 40),
      ...repeatedSamples(2000, 60),
    ];

    const loud = analyzePcm16Mono(pcmBytesFromSamples(loudSamples), 1000);
    const quiet = analyzePcm16Mono(pcmBytesFromSamples(quietSamples), 1000);

    expect(loud.leadingSilenceMs).toBe(40);
    expect(quiet.leadingSilenceMs).toBe(40);
    expect(loud.speechRmsDbfs).not.toBeNull();
    expect(quiet.speechRmsDbfs).not.toBeNull();
    expect((loud.speechRmsDbfs ?? 0) - (quiet.speechRmsDbfs ?? 0)).toBeCloseTo(6.02, 1);
  });

  it("merges short inactive gaps into a single speech region", () => {
    const samples = [
      ...repeatedSamples(2500, 20),
      ...repeatedSamples(0, 40),
      ...repeatedSamples(2500, 20),
    ];

    const analysis = analyzePcm16Mono(pcmBytesFromSamples(samples), 1000);

    expect(analysis.leadingSilenceMs).toBe(0);
    expect(analysis.speechFrameCount).toBe(4);
    expect(analysis.speechDurationMs).toBe(80);
  });
});
