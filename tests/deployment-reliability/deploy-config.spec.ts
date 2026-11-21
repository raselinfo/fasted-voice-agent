import { describe, expect, it } from "vitest";
import wranglerConfigRaw from "../../wrangler.jsonc?raw";

describe("Phase 3 deploy configuration", () => {
  it("RELY-02 enables assets, observability, and required secret validation in wrangler.jsonc", () => {
    const config = JSON.parse(wranglerConfigRaw) as {
      ai?: { binding?: string };
      assets?: { directory?: string; binding?: string; run_worker_first?: boolean };
      observability?: { enabled?: boolean; logs?: { invocation_logs?: boolean } };
      routes?: Array<{ pattern?: string; zone_name?: string }>;
      secrets?: { required?: string[] };
      vars?: {
        APP_BASE_PATH?: string;
        TURN_DETECTOR_PROVIDER?: string;
        POSTHOG_API_HOST?: string;
        POSTHOG_ENABLE_SESSION_REPLAY?: string;
        POSTHOG_CAPTURE_TRANSCRIPTS?: string;
      };
    };

    expect(config.ai?.binding).toBe("AI");
    expect(config.vars?.APP_BASE_PATH).toBe("/voice-agent");
    expect(config.vars?.TURN_DETECTOR_PROVIDER).toBe("workers-ai-flux");
    expect(config.vars?.POSTHOG_API_HOST).toBe("https://us.i.posthog.com");
    expect(config.vars?.POSTHOG_ENABLE_SESSION_REPLAY).toBe("false");
    expect(config.vars?.POSTHOG_CAPTURE_TRANSCRIPTS).toBe("true");
    expect(config.assets?.directory).toBe("src/web");
    expect(config.assets?.binding).toBe("ASSETS");
    expect(config.assets?.run_worker_first).toBe(true);
    expect(config.observability?.enabled).toBe(true);
    expect(config.observability?.logs?.invocation_logs).toBe(true);
    expect(config.routes).toEqual([
      { pattern: "aa0.dev/voice-agent", zone_name: "aa0.dev" },
      { pattern: "aa0.dev/voice-agent/*", zone_name: "aa0.dev" },
    ]);
    expect(config.secrets?.required).toEqual(["GROQ_API_KEYS", "TOGETHER_API_KEY", "ELEVENLABS_API_KEY"]);
  });
});
