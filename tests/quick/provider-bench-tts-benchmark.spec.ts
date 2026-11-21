import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ttsBenchmarkModulePath = "../../scripts/provider-bench/tts-benchmark.mjs";
const {
  createTtsPlan,
  deriveSuggestedGainDb,
  loadTtsPromptSet,
  renderTtsMarkdown,
  summariseTtsRuns,
} = await import(ttsBenchmarkModulePath);

describe("provider bench TTS benchmark helpers", () => {
  it("loads the dedicated loudness prompt set", async () => {
    const prompts = await loadTtsPromptSet(resolve(process.cwd(), "scripts/provider-bench/tts-prompts.json"));

    expect(prompts).toHaveLength(4);
    expect(prompts.map((prompt: { id: string }) => prompt.id)).toEqual([
      "short_ack",
      "medium_statement",
      "pausey_question",
      "longer_explainer",
    ]);
  });

  it("uses Aura 2, ElevenLabs, and Together Orpheus as the default plan", () => {
    expect(createTtsPlan()).toEqual([
      { provider: "workers-ai", model: "@cf/deepgram/aura-2-en", label: "Aura 2" },
      { provider: "elevenlabs", model: "eleven_flash_v2_5", label: "ElevenLabs Flash v2.5" },
      {
        provider: "together-orpheus",
        model: "canopylabs/orpheus-3b-0.1-ft",
        voice: "leo",
        label: "Together Orpheus",
      },
    ]);
  });

  it("summarises loudness fields and derives gain deltas from median speech RMS", () => {
    const auraSummary = {
      provider: "workers-ai",
      model: "@cf/deepgram/aura-2-en",
      ...summariseTtsRuns([
        {
          ttfaMs: 120,
          ttsDoneMs: 500,
          realTimeFactor: 0.8,
          leadingSilenceMs: 30,
          speechDurationMs: 900,
          speechRmsDbfs: -21,
          integratedRmsDbfs: -22,
          integratedLoudnessLufs: -20,
          loudnessRangeLu: 1.5,
          peakDbfs: -3,
          truePeakDbfs: -2.5,
        },
        {
          ttfaMs: 140,
          ttsDoneMs: 520,
          realTimeFactor: 0.82,
          leadingSilenceMs: 35,
          speechDurationMs: 920,
          speechRmsDbfs: -22,
          integratedRmsDbfs: -23,
          integratedLoudnessLufs: -21,
          loudnessRangeLu: 1.7,
          peakDbfs: -2.8,
          truePeakDbfs: -2.3,
        },
      ]),
    };
    const elevenSummary = {
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      ...summariseTtsRuns([
        {
          ttfaMs: 100,
          ttsDoneMs: 480,
          realTimeFactor: 0.75,
          leadingSilenceMs: 15,
          speechDurationMs: 860,
          speechRmsDbfs: -18,
          integratedRmsDbfs: -19,
          integratedLoudnessLufs: -17,
          loudnessRangeLu: 1.2,
          peakDbfs: -1.8,
          truePeakDbfs: -1.4,
        },
      ]),
    };

    const gain = deriveSuggestedGainDb([auraSummary, elevenSummary]);
    const markdown = renderTtsMarkdown(
      [
        {
          ...auraSummary,
          suggestedGainDbToMedianSpeechRms: gain.suggestedGainByKey["workers-ai:@cf/deepgram/aura-2-en"],
        },
        {
          ...elevenSummary,
          suggestedGainDbToMedianSpeechRms: gain.suggestedGainByKey["elevenlabs:eleven_flash_v2_5"],
        },
      ],
      {
        probeUrl: "http://127.0.0.1:8791",
        promptSetPath: "scripts/provider-bench/tts-prompts.json",
        sampleCount: 2,
        targetSpeechRmsDbfs: gain.targetSpeechRmsDbfs,
      },
    );

    expect(auraSummary.speechRmsDbfs?.median).toBe(-21.5);
    expect(gain.targetSpeechRmsDbfs).toBe(-19.75);
    expect(gain.suggestedGainByKey["workers-ai:@cf/deepgram/aura-2-en"]).toBe(1.75);
    expect(gain.suggestedGainByKey["elevenlabs:eleven_flash_v2_5"]).toBe(-1.75);
    expect(markdown).toContain("Target median speech RMS");
    expect(markdown).toContain("@cf/deepgram/aura-2-en");
    expect(markdown).toContain("eleven_flash_v2_5");
  });
});
