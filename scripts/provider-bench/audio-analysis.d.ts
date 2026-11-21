export type WavPcm16 = {
  pcmBytes: Uint8Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
};

export type PcmAnalysis = {
  audioDurationMs: number;
  leadingSilenceMs: number;
  speechDurationMs: number;
  speechRmsDbfs: number | null;
  integratedRmsDbfs: number | null;
  peakDbfs: number | null;
  frameCount: number;
  speechFrameCount: number;
  noiseFloorDbfs: number | null;
  gateDbfs: number | null;
};

export function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array;
export function encodeBase64(bytes: Uint8Array | ArrayBuffer): string;
export function extractWavPcm16(bytes: Uint8Array | ArrayBuffer): WavPcm16;
export function createPcm16Wav(bytes: Uint8Array | ArrayBuffer, sampleRate: number): Uint8Array;
export function analyzePcm16Mono(
  pcmBytes: Uint8Array | ArrayBuffer,
  sampleRate: number,
  options?: {
    frameMs?: number;
    gapMergeMs?: number;
    noiseFloorPercentile?: number;
    noiseFloorMarginDb?: number;
    minGateDbfs?: number;
  },
): PcmAnalysis;
