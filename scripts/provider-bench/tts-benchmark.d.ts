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

export const DEFAULT_TTS_PROMPT_SET_PATH: string;
export const DEFAULT_TTS_BASELINE_JSON_PATH: string;
export const DEFAULT_TTS_BASELINE_MD_PATH: string;
export const DEFAULT_TTS_PLAN: TtsPlanEntry[];
export const ORPHEUS_HEAD_TO_HEAD_TTS_PLAN: TtsPlanEntry[];

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
