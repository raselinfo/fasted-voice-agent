import { describe, expect, it } from "vitest";

import worker, { type Env } from "../../src/worker/index";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION_DO: {
      getByName() {
        throw new Error("SESSION_DO should not be used in health checks");
      },
    } as unknown as Env["SESSION_DO"],
    AI: {
      async run() {
        return new Response();
      },
    },
    ...overrides,
  };
}

describe("Phase 3 runtime readiness", () => {
  it("RELY-01 returns 503 with missing secret names when health check is not configured", async () => {
    const response = await worker.fetch(new Request("https://example.com/api/health"), createEnv());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      service: "voice-agent",
      missingSecrets: ["DEEPGRAM_KEY", "GROQ_API_KEYS", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"],
      missingBindings: [],
      runtime: "cloudflare-workers",
    });
  });

  it("RELY-01 returns 200 for deepgram-direct when baseline secrets are present via DEEPGRAM_API_KEY", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/health"),
      createEnv({
        DEEPGRAM_API_KEY: "dg-api",
        GROQ_API_KEY: "gq",
        ELEVENLABS_API_KEY: "el",
        ELEVENLABS_VOICE_ID: "voice",
        AI: undefined,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "voice-agent",
      missingSecrets: [],
      missingBindings: [],
      runtime: "cloudflare-workers",
    });
  });

  it("RELY-01 returns 503 when workers-ai-flux is selected without the AI binding", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/health"),
      createEnv({
        TURN_DETECTOR_PROVIDER: "workers-ai-flux",
        GROQ_API_KEY: "gq",
        ELEVENLABS_API_KEY: "el",
        ELEVENLABS_VOICE_ID: "voice",
        AI: undefined,
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      service: "voice-agent",
      missingSecrets: [],
      missingBindings: ["AI"],
      runtime: "cloudflare-workers",
    });
  });

  it("RELY-01 returns 200 for workers-ai-flux without Deepgram secrets when baseline secrets and AI are present", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/health"),
      createEnv({
        TURN_DETECTOR_PROVIDER: "workers-ai-flux",
        GROQ_API_KEY: "gq",
        ELEVENLABS_API_KEY: "el",
        ELEVENLABS_VOICE_ID: "voice",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "voice-agent",
      missingSecrets: [],
      missingBindings: [],
      runtime: "cloudflare-workers",
    });
  });

  it("serves the health check under APP_BASE_PATH when configured", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/voice-agent/api/health"),
      createEnv({
        APP_BASE_PATH: "/voice-agent",
        TURN_DETECTOR_PROVIDER: "workers-ai-flux",
        GROQ_API_KEY: "gq",
        TOGETHER_API_KEY: "tg",
        TTS_PROVIDER: "together-orpheus",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "voice-agent",
      missingSecrets: [],
      missingBindings: [],
      runtime: "cloudflare-workers",
    });
  });
});
