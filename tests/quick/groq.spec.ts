import { afterEach, describe, expect, it, vi } from "vitest";

import { GROQ_MODEL, streamAssistantText } from "../../src/adapters/groq";

function createSseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
      },
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Groq adapter", () => {
  it("uses gpt-oss-120b for the main agent with reasoning disabled and max completion tokens set", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      createSseResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: string[] = [];
    for await (const chunk of streamAssistantText(
      [{ role: "user", content: "Hi" }],
      "groq-key",
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello"]);
    expect(GROQ_MODEL).toBe("openai/gpt-oss-120b");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(request?.body));

    expect(body).toEqual(
      expect.objectContaining({
        model: "openai/gpt-oss-120b",
        stream: true,
        include_reasoning: false,
        max_completion_tokens: 128,
        stream_options: {
          include_usage: true,
        },
      }),
    );
  });
});
