export type ConversationMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ProviderLabels = {
  turnDetector: string;
  textGenerator: string;
  speechSynthesizer: string;
};

export type TurnDetectorSessionOptions = {
  sampleRate: number;
  onStartOfTurn: (transcriptHint?: string) => void;
  onEagerEndOfTurn?: (transcript: string) => void | Promise<void>;
  onEndOfTurn: (finalTranscript: string) => void | Promise<void>;
  onTurnResumed?: () => void;
  onError?: (error: Error) => void;
};

export interface TurnDetectorSession {
  connect(): Promise<void>;
  sendAudioChunk(chunk: Uint8Array | ArrayBuffer): void;
  close(): void;
}

export interface TurnDetectorFactory {
  createSession(options: TurnDetectorSessionOptions): TurnDetectorSession;
}

export interface TextGenerator {
  streamText(
    messages: ConversationMessage[],
    signal: AbortSignal,
    onUsage?: (usage: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cachedTokens?: number;
      queueTime?: number;
      promptTime?: number;
      completionTime?: number;
      totalTime?: number;
    }) => void,
  ): AsyncGenerator<string>;
}

export type SpeechSynthesizerStreamOptions = {
  onAudioChunk: (chunk: Uint8Array) => void;
  onError?: (error: Error) => void;
};

export interface SpeechSynthesizerStream {
  connect(): Promise<void>;
  sendText(text: string): void;
  flush(): Promise<void>;
  close(aborted?: boolean): void;
}

export interface SpeechSynthesizerFactory {
  readonly sampleRate: number;
  prewarm?(): Promise<void>;
  createStream(options: SpeechSynthesizerStreamOptions): SpeechSynthesizerStream;
}

export interface ProviderRuntime {
  readonly labels: ProviderLabels;
  readonly turnDetector: TurnDetectorFactory;
  readonly textGenerator: TextGenerator;
  readonly speechSynthesizer: SpeechSynthesizerFactory;
  /** Serialized Workers AI binding (all AI.run calls flow through one mutex). */
  readonly ai?: WorkersAiBinding;
  dispose?(): void;
}

export type RuntimeEnvGetter = (key: string) => string | undefined;

export type WorkersAiBinding = {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
};

export type TurnDetectorProvider = "deepgram-direct" | "workers-ai-flux";
export type TtsProvider = "elevenlabs" | "workers-ai-aura" | "together-orpheus";
export type TextGeneratorProvider = "groq" | "workers-ai";

export type ProviderRuntimeBindings = {
  getEnvValue: RuntimeEnvGetter;
  ai?: WorkersAiBinding;
  groqApiKey?: string;
  ttsProviderOverride?: TtsProvider;
  ttsModelOverride?: string;
  ttsVoiceOverride?: string;
};

export const DEFAULT_TURN_DETECTOR_PROVIDER: TurnDetectorProvider = "deepgram-direct";
export const DEFAULT_TTS_PROVIDER: TtsProvider = "elevenlabs";
export const DEFAULT_TEXT_GENERATOR_PROVIDER: TextGeneratorProvider = "groq";

export function resolveTurnDetectorProvider(value: string | undefined): TurnDetectorProvider {
  return value === "workers-ai-flux" ? value : DEFAULT_TURN_DETECTOR_PROVIDER;
}

export function resolveTtsProvider(value: string | undefined): TtsProvider {
  return value === "workers-ai-aura" || value === "together-orpheus" ? value : DEFAULT_TTS_PROVIDER;
}

export function resolveTextGeneratorProvider(value: string | undefined): TextGeneratorProvider {
  return value === "workers-ai" ? value : DEFAULT_TEXT_GENERATOR_PROVIDER;
}
