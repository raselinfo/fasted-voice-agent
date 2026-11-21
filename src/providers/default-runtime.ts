import { DeepgramFluxBridge } from "../adapters/deepgram-flux";
import {
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_SAMPLE_RATE,
  ElevenLabsMultiContextSocket,
  ElevenLabsTtsStream,
} from "../adapters/elevenlabs";
import {
  TOGETHER_ORPHEUS_DEFAULT_MODEL,
  TOGETHER_ORPHEUS_SAMPLE_RATE,
  TogetherOrpheusTtsStream,
} from "../adapters/together-orpheus";
import { AURA_DEFAULT_MODEL, AURA_SAMPLE_RATE, WorkersAiAuraTtsStream } from "../adapters/workers-ai-aura";
import { WorkersAiFluxBridge } from "../adapters/workers-ai-flux";
import { streamAssistantTextWithWorkersAi } from "../adapters/workers-ai-text";
import { streamAssistantText } from "../adapters/groq";
import { resolveTextGeneratorProvider, resolveTtsProvider, resolveTurnDetectorProvider } from "./contracts";
import type {
  ProviderRuntimeBindings,
  ProviderRuntime,
  RuntimeEnvGetter,
  SpeechSynthesizerStreamOptions,
  TurnDetectorSessionOptions,
  WorkersAiBinding,
} from "./contracts";

function normalizeBindings(bindings: ProviderRuntimeBindings | RuntimeEnvGetter): ProviderRuntimeBindings {
  if (typeof bindings === "function") {
    return {
      getEnvValue: bindings,
    };
  }

  return bindings;
}

// Workers AI concurrency quirk (verified via probes on 2026-11-21):
// - flux WS upgrade + llama inference concurrently -> flux upgrade fails (InferenceUpstreamError)
// - aura TTS + llama/gpt-oss inference concurrently -> aura returns undefined/no body
// Serializing every AI.run through one mutex avoids all of these failures.
// Cost: TTS for a clause starts after the LLM stream finishes (slightly higher latency).
function createSerializedAiBinding(ai: WorkersAiBinding): WorkersAiBinding {
  let lastCall: Promise<unknown> = Promise.resolve();

  return {
    run(model, input, options) {
      const execute = () =>
        Promise.resolve(ai.run(model, input, options)).finally(() => {
          // Keep the chain alive even when a call rejects.
        });
      const gated = lastCall.then(execute, execute);
      lastCall = gated.catch(() => undefined);
      return gated;
    },
  };
}

function createDirectFluxSession(getEnvValue: RuntimeEnvGetter, options: TurnDetectorSessionOptions) {
  const apiKey = getEnvValue("DEEPGRAM_API_KEY") ?? getEnvValue("DEEPGRAM_KEY");
  if (!apiKey) {
    throw new Error("Missing DEEPGRAM_KEY.");
  }

  return new DeepgramFluxBridge({
    apiKey,
    sampleRate: options.sampleRate,
    eotThreshold: 0.7,
    eagerEotThreshold: 0.3,
    eotTimeoutMs: 1100,
    onStartOfTurn: options.onStartOfTurn,
    onEagerEndOfTurn: options.onEagerEndOfTurn,
    onEndOfTurn: options.onEndOfTurn,
    onTurnResumed: options.onTurnResumed,
    onError: options.onError,
  });
}

function createWorkersAiFluxSession(ai: WorkersAiBinding | undefined, options: TurnDetectorSessionOptions) {
  if (!ai) {
    throw new Error("Missing Workers AI binding.");
  }

  return new WorkersAiFluxBridge({
    ai,
    sampleRate: options.sampleRate,
    eotThreshold: 0.7,
    eagerEotThreshold: 0.3,
    eotTimeoutMs: 1100,
    onStartOfTurn: options.onStartOfTurn,
    onEagerEndOfTurn: options.onEagerEndOfTurn,
    onEndOfTurn: options.onEndOfTurn,
    onTurnResumed: options.onTurnResumed,
    onError: options.onError,
  });
}

const TTS_GAIN_DB_BY_PROVIDER_MODEL: Record<string, number> = {
  "workers-ai-aura:@cf/deepgram/aura-2-en": 1.5,
  "elevenlabs:eleven_flash_v2_5": 0,
  "together-orpheus:canopylabs/orpheus-3b-0.1-ft": -3.03,
};

function resolveTtsGainDb(ttsProvider: string, model: string): number {
  return TTS_GAIN_DB_BY_PROVIDER_MODEL[`${ttsProvider}:${model}`] ?? 0;
}

export function createDefaultProviderRuntime(
  input: ProviderRuntimeBindings | RuntimeEnvGetter,
): ProviderRuntime {
  const bindings = normalizeBindings(input);
  const { getEnvValue } = bindings;
  const serializedAi = bindings.ai ? createSerializedAiBinding(bindings.ai) : undefined;
  const ai = serializedAi;
  const turnDetectorProvider = resolveTurnDetectorProvider(getEnvValue("TURN_DETECTOR_PROVIDER"));
  const textGeneratorProvider = resolveTextGeneratorProvider(getEnvValue("TEXT_GENERATOR_PROVIDER"));
  const ttsProvider = bindings.ttsProviderOverride ?? resolveTtsProvider(getEnvValue("TTS_PROVIDER"));
  const ttsModelOverride = bindings.ttsModelOverride?.trim() || undefined;
  const ttsVoiceOverride = bindings.ttsVoiceOverride?.trim() || undefined;
  const resolvedTtsModel =
    ttsProvider === "workers-ai-aura"
      ? ttsModelOverride ?? AURA_DEFAULT_MODEL
      : ttsProvider === "together-orpheus"
        ? ttsModelOverride ?? TOGETHER_ORPHEUS_DEFAULT_MODEL
        : ELEVENLABS_DEFAULT_MODEL;
  const ttsGainDb = resolveTtsGainDb(ttsProvider, resolvedTtsModel);
  const speechSynthesizerSampleRate =
    ttsProvider === "workers-ai-aura"
      ? AURA_SAMPLE_RATE
      : ttsProvider === "together-orpheus"
        ? TOGETHER_ORPHEUS_SAMPLE_RATE
        : ELEVENLABS_SAMPLE_RATE;
  const elevenLabsManager =
    ttsProvider === "elevenlabs"
      ? new ElevenLabsMultiContextSocket({
          voiceId: ttsVoiceOverride ?? getEnvValue("ELEVENLABS_VOICE_ID"),
          apiKey: getEnvValue("ELEVENLABS_API_KEY"),
        })
      : null;

  return {
    labels: {
      turnDetector: turnDetectorProvider,
      textGenerator: textGeneratorProvider,
      speechSynthesizer: ttsProvider,
    },
    ai: serializedAi,
    turnDetector: {
      createSession(options: TurnDetectorSessionOptions) {
        if (turnDetectorProvider === "workers-ai-flux") {
          return createWorkersAiFluxSession(ai, options);
        }

        return createDirectFluxSession(getEnvValue, options);
      },
    },
    textGenerator: {
      streamText(messages, signal, onUsage) {
        if (textGeneratorProvider === "workers-ai") {
          return streamAssistantTextWithWorkersAi(messages, ai, signal);
        }
        return streamAssistantText(messages, bindings.groqApiKey ?? getEnvValue("GROQ_API_KEY"), signal, onUsage);
      },
    },
    speechSynthesizer: {
      sampleRate: speechSynthesizerSampleRate,
      async prewarm() {
        if (ttsProvider === "elevenlabs") {
          await elevenLabsManager?.connect();
        }
      },
      createStream(options: SpeechSynthesizerStreamOptions) {
        if (ttsProvider === "workers-ai-aura") {
          return new WorkersAiAuraTtsStream({
            ai,
            model: resolvedTtsModel,
            speaker: ttsVoiceOverride,
            gainDb: ttsGainDb,
            onAudioChunk: options.onAudioChunk,
            onError: options.onError,
          });
        }

        if (ttsProvider === "together-orpheus") {
          return new TogetherOrpheusTtsStream({
            apiKey: getEnvValue("TOGETHER_API_KEY"),
            model: resolvedTtsModel,
            voice: ttsVoiceOverride ?? getEnvValue("TOGETHER_TTS_VOICE"),
            gainDb: ttsGainDb,
            onAudioChunk: options.onAudioChunk,
            onError: options.onError,
          });
        }

        if (!elevenLabsManager) {
          throw new Error("Missing ElevenLabs runtime.");
        }

        return new ElevenLabsTtsStream(elevenLabsManager, {
          voiceId: ttsVoiceOverride ?? getEnvValue("ELEVENLABS_VOICE_ID"),
          apiKey: getEnvValue("ELEVENLABS_API_KEY"),
          gainDb: ttsGainDb,
          onAudioChunk: options.onAudioChunk,
          onError: options.onError,
        });
      },
    },
    dispose() {
      elevenLabsManager?.closeSocket(true);
    },
  };
}
