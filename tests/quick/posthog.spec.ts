import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPostHogBrowserConfig,
  buildPostHogBrowserBootstrapScript,
  normalizePostHogApiHost,
} from "../../src/analytics/posthog";
import worker, { type Env } from "../../src/worker/index";
import type { ConversationMessage, ProviderRuntime } from "../../src/providers/contracts";

class CapturingSocket {
  readonly sentStrings: string[] = [];
  readonly sentBinary: Uint8Array[] = [];

  send(payload: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof payload === "string") {
      this.sentStrings.push(payload);
      return;
    }

    if (payload instanceof ArrayBuffer) {
      this.sentBinary.push(new Uint8Array(payload));
      return;
    }

    this.sentBinary.push(new Uint8Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)));
  }

  close(): void {}
}

type SessionDOProbe = {
  activeSocket: WebSocket | null;
  activeSessionId: string | null;
  state: "idle" | "listening" | "thinking" | "speaking" | "interrupted" | "error";
  providerRuntime?: ProviderRuntime | null;
  analyticsDistinctId?: string | null;
  analyticsSessionId?: string | null;
  sessionScenario?: "drive-thru" | "restaurant-booking" | "customer-support";
  env?: {
    POSTHOG_PROJECT_API_KEY?: string;
    POSTHOG_API_HOST?: string;
    POSTHOG_CAPTURE_TRANSCRIPTS?: string;
  };
  handleEndOfTurn(finalTranscript: string): Promise<void>;
};

function createFakeRuntime(
  impls: Array<(messages: ConversationMessage[], signal: AbortSignal) => AsyncGenerator<string>>,
): ProviderRuntime {
  return {
    labels: {
      turnDetector: "fake-turn-detector",
      textGenerator: "fake-llm",
      speechSynthesizer: "fake-tts",
    },
    turnDetector: {
      createSession() {
        return {
          async connect() {},
          sendAudioChunk() {},
          close() {},
        };
      },
    },
    textGenerator: {
      streamText(messages, signal) {
        const impl =
          impls.shift() ??
          (async function* () {
            yield "fallback.";
          });
        return impl(messages, signal);
      },
    },
    speechSynthesizer: {
      sampleRate: 16000,
      async prewarm() {},
      createStream({ onAudioChunk }) {
        const texts: string[] = [];
        return {
          async connect() {},
          sendText(text: string) {
            texts.push(text);
          },
          async flush() {
            onAudioChunk(new TextEncoder().encode(texts.join("")));
          },
          close() {},
        };
      },
    },
  };
}

async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error("Condition was not met in time.");
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION_DO: {
      getByName() {
        throw new Error("SESSION_DO should not be used in asset tests");
      },
    } as unknown as Env["SESSION_DO"],
    ...overrides,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PostHog analytics config", () => {
  it("builds the browser config with US cloud defaults and transcript capture enabled", () => {
    expect(
      buildPostHogBrowserConfig({
        POSTHOG_PROJECT_API_KEY: "phc_test",
      }),
    ).toEqual({
      apiKey: "phc_test",
      apiHost: "https://us.i.posthog.com",
      defaults: "2026-01-30",
      appSurface: "voice-agent",
      enableSessionReplay: false,
      captureTranscripts: true,
    });
    expect(normalizePostHogApiHost("https://us.i.posthog.com/")).toBe("https://us.i.posthog.com");
    expect(buildPostHogBrowserBootstrapScript(buildPostHogBrowserConfig({ POSTHOG_PROJECT_API_KEY: "phc_test" })!)).toContain(
      "window.__POSTHOG_CONFIG__",
    );
  });

  it("injects PostHog bootstrap into HTML assets served under APP_BASE_PATH", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/voice-agent/"),
      createEnv({
        APP_BASE_PATH: "/voice-agent",
        POSTHOG_PROJECT_API_KEY: "phc_test",
        POSTHOG_API_HOST: "https://us.i.posthog.com",
        ASSETS: {
          fetch: vi.fn(async () =>
            new Response(
              '<!doctype html><html><head><link rel="stylesheet" href="/styles.css" /></head><body><script src="/app.js"></script></body></html>',
              {
                headers: {
                  "content-type": "text/html; charset=utf-8",
                },
              },
            ),
          ),
          connect() {
            throw new Error("ASSETS.connect should not be called in tests");
          },
        } as unknown as Env["ASSETS"],
      }),
    );

    const html = await response.text();
    expect(html).toContain('window.__APP_BASE_PATH__="/voice-agent"');
    expect(html).toContain("window.__POSTHOG_CONFIG__=");
    expect(html).toContain("phc_test");
    expect(html).toContain('href="/voice-agent/styles.css"');
    expect(html).toContain('src="/voice-agent/app.js"');
  });
});

describe("PostHog server-side capture", () => {
  it("captures authoritative user and assistant transcript events from SessionDO", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = createFakeRuntime([
      async function* () {
        yield "Hello back.";
      },
      async function* () {
        yield JSON.stringify({ actions: [] });
      },
    ]);

    const { SessionDO } = await import("../../src/durable/session-do");
    const socket = new CapturingSocket();
    const session = Object.assign(Object.create(SessionDO.prototype), {
      activeSocket: socket,
      activeSessionId: "posthog-session",
      state: "listening",
      providerRuntime: runtime,
      analyticsDistinctId: "ph-distinct-id",
      analyticsSessionId: "ph-session-id",
      sessionScenario: "drive-thru",
      env: {
        POSTHOG_PROJECT_API_KEY: "phc_test",
        POSTHOG_API_HOST: "https://us.i.posthog.com",
        POSTHOG_CAPTURE_TRANSCRIPTS: "true",
      },
    }) as SessionDOProbe;

    await session.handleEndOfTurn("Hello there");
    await waitFor(() => fetchMock.mock.calls.length >= 2);

    const payloads = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map((call) =>
      JSON.parse(String(call[1].body)),
    );

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          api_key: "phc_test",
          event: "voice_agent_user_turn_final",
          distinct_id: "ph-distinct-id",
          properties: expect.objectContaining({
            app_surface: "voice-agent",
            call_session_id: "posthog-session",
            posthog_session_id: "ph-session-id",
            scenario: "drive-thru",
            turn_id: 1,
            text: "Hello there",
          }),
        }),
        expect.objectContaining({
          api_key: "phc_test",
          event: "voice_agent_assistant_turn_final",
          distinct_id: "ph-distinct-id",
          properties: expect.objectContaining({
            app_surface: "voice-agent",
            call_session_id: "posthog-session",
            posthog_session_id: "ph-session-id",
            scenario: "drive-thru",
            assistant_turn_id: 1,
            text: "Hello back.",
          }),
        }),
      ]),
    );
  });
});
