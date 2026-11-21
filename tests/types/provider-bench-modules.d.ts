declare module "../../scripts/provider-bench/audio-analysis.mjs" {
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
}

declare module "../../scripts/provider-bench/tts-benchmark.mjs" {
  export type TtsPrompt = {
    id: string;
    label: string;
    text: string;
  };

  export type TtsPlanEntry = {
    provider: string;
    model: string;
    voice?: string;
    label?: string;
  };

  export type NumericSummary = {
    min: number;
    median: number;
    mean: number;
    max: number;
    samples: number[];
  };

  export type TtsRunMetrics = {
    ttfaMs?: number;
    ttsDoneMs?: number;
    realTimeFactor?: number;
    leadingSilenceMs?: number;
    speechDurationMs?: number;
    speechRmsDbfs?: number;
    integratedRmsDbfs?: number;
    integratedLoudnessLufs?: number;
    loudnessRangeLu?: number;
    peakDbfs?: number;
    truePeakDbfs?: number;
  };

  export type TtsSummary = {
    ttfa: NumericSummary | null;
    ttsDone: NumericSummary | null;
    realTimeFactor: NumericSummary | null;
    leadingSilenceMs: NumericSummary | null;
    speechDurationMs: NumericSummary | null;
    speechRmsDbfs: NumericSummary | null;
    integratedRmsDbfs: NumericSummary | null;
    integratedLoudnessLufs: NumericSummary | null;
    loudnessRangeLu: NumericSummary | null;
    peakDbfs: NumericSummary | null;
    truePeakDbfs: NumericSummary | null;
  };

  export function loadTtsPromptSet(promptSetPath: string): Promise<TtsPrompt[]>;
  export function createTtsPlan(options?: { orpheusHeadToHead?: boolean }): TtsPlanEntry[];
  export function summariseTtsRuns(runs: TtsRunMetrics[]): TtsSummary;
  export function deriveSuggestedGainDb(results: Array<{
    provider: string;
    model: string;
    speechRmsDbfs?: NumericSummary | null;
  }>): {
    targetSpeechRmsDbfs: number | null;
    suggestedGainByKey: Record<string, number | null>;
  };
  export function renderTtsMarkdown(
    results: Array<{
      provider: string;
      model: string;
      ttfa?: NumericSummary | null;
      speechRmsDbfs?: NumericSummary | null;
      integratedLoudnessLufs?: NumericSummary | null;
      leadingSilenceMs?: NumericSummary | null;
      truePeakDbfs?: NumericSummary | null;
      suggestedGainDbToMedianSpeechRms?: number | null;
    }>,
    options: {
      probeUrl: string;
      promptSetPath: string;
      sampleCount: number;
      targetSpeechRmsDbfs: number | null;
    },
  ): string;
}
