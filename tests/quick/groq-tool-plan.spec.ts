import { afterEach, describe, expect, it, vi } from "vitest";

import { generateBackgroundToolPlanWithNativeCalls } from "../../src/adapters/groq";
import type { ConversationMessage } from "../../src/providers/contracts";

describe("generateBackgroundToolPlanWithNativeCalls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries when failed_generation cannot be repaired into valid JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "tool_use_failed",
              failed_generation:
                "{\"name\": \"submit_actions\", \"arguments\": {\"actions\":[{\"tool\":\"submit_order\",\"args\":{}}]\"}",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      function: {
                        name: "submit_actions",
                        arguments: JSON.stringify({
                          actions: [{ tool: "submit_order", args: {} }],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const messages: ConversationMessage[] = [
      {
        role: "system",
        content: "Plan tool calls.",
      },
      {
        role: "user",
        content: "Submit my order.",
      },
    ];

    const result = await generateBackgroundToolPlanWithNativeCalls(
      messages,
      ["submit_order"],
      "test-key",
      new AbortController().signal,
    );

    expect(result).toEqual({
      actions: [{ tool: "submit_order", args: {} }],
      toolCallCount: 1,
      messageContent: "",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retryRequest = fetchMock.mock.calls[1]?.[1];
    const retryBody =
      retryRequest && typeof retryRequest === "object" && "body" in retryRequest && typeof retryRequest.body === "string"
        ? JSON.parse(retryRequest.body)
        : null;

    expect(retryBody?.messages.at(-1)?.content).toContain("Retry now with exactly one submit_actions call");
  });
});
