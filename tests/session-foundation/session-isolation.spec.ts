import { describe, expect, it, vi } from "vitest";

import type { SessionDO } from "../../src/durable/session-do";
import worker, { type Env } from "../../src/worker/index";

type RoutedCall = { sessionId: string; request: Request };

function createEnv(calls: RoutedCall[]): Env {
  return {
    SESSION_DO: {
      getByName(sessionId: string) {
        return {
          fetch(request: Request): Promise<Response> {
            calls.push({ sessionId, request });
            return Promise.resolve(
              new Response(JSON.stringify({ routedTo: sessionId }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          },
        } as DurableObjectStub<SessionDO>;
      },
    } as DurableObjectNamespace<SessionDO>,
  };
}

describe("SESS-01 session routing", () => {
  it("SESS-01 routes websocket /api/session requests to the matching Durable Object name", async () => {
    const calls: RoutedCall[] = [];
    const response = await worker.fetch(
      new Request("https://example.com/api/session?sessionId=tab-a", {
        headers: { Upgrade: "websocket" },
      }),
      createEnv(calls),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe("tab-a");
    expect(new URL(calls[0]!.request.url).searchParams.get("sessionId")).toBe("tab-a");
  });

  it("routes websocket requests under APP_BASE_PATH to the matching Durable Object name", async () => {
    const calls: RoutedCall[] = [];
    const response = await worker.fetch(
      new Request("https://example.com/voice-agent/api/session?sessionId=tab-a", {
        headers: { Upgrade: "websocket" },
      }),
      {
        ...createEnv(calls),
        APP_BASE_PATH: "/voice-agent",
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe("tab-a");
    expect(new URL(calls[0]!.request.url).pathname).toBe("/api/session");
    expect(new URL(calls[0]!.request.url).searchParams.get("sessionId")).toBe("tab-a");
  });

  it("SESS-01 routes different session IDs to different Durable Object names", async () => {
    const calls: RoutedCall[] = [];
    const env = createEnv(calls);

    const tabAResponse = await worker.fetch(
      new Request("https://example.com/api/session?sessionId=tab-a", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );
    const tabBResponse = await worker.fetch(
      new Request("https://example.com/api/session?sessionId=tab-b", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );

    expect(await tabAResponse.json()).toEqual({ routedTo: "tab-a" });
    expect(await tabBResponse.json()).toEqual({ routedTo: "tab-b" });
    expect(calls.map((call) => call.sessionId)).toEqual(["tab-a", "tab-b"]);
    expect(new Set(calls.map((call) => call.sessionId)).size).toBe(2);
  });

  it("SESS-01 rejects non-websocket /api/session requests with 426", async () => {
    const calls: RoutedCall[] = [];
    const response = await worker.fetch(new Request("https://example.com/api/session"), createEnv(calls));

    expect(response.status).toBe(426);
    expect(await response.text()).toBe("Expected WebSocket upgrade");
    expect(calls).toHaveLength(0);
  });

  it("SESS-01 only allows GET for websocket session upgrades", async () => {
    const calls: RoutedCall[] = [];
    const randomId = vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    const response = await worker.fetch(
      new Request("https://example.com/api/session", {
        method: "POST",
        headers: { Upgrade: "websocket" },
      }),
      createEnv(calls),
    );

    expect(response.status).toBe(405);
    expect(calls).toHaveLength(0);
    expect(randomId).not.toHaveBeenCalled();
    randomId.mockRestore();
  });
});
