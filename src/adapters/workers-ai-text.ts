import type { ConversationMessage, WorkersAiBinding } from "../providers/contracts";

export type { ConversationMessage } from "../providers/contracts";

export const WORKERS_AI_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const WORKERS_AI_TOOL_PLAN_MODEL = "@cf/openai/gpt-oss-20b";
const MAX_COMPLETION_TOKENS = 128;

type WorkersAiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: {
          name?: string | null;
          arguments?: string | null;
        } | null;
      }> | null;
    };
  }>;
};

type JsonSchema = {
  type: string;
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type BackgroundToolPlanAction = {
  tool: string;
  args: Record<string, unknown>;
};

export type BackgroundToolPlanFromNativeCalls = {
  actions: BackgroundToolPlanAction[];
  toolCallCount: number;
  messageContent: string;
};

function assertBinding(ai: WorkersAiBinding | undefined): WorkersAiBinding {
  if (!ai) {
    throw new Error("Missing Workers AI binding.");
  }
  return ai;
}

type StreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
    } | null;
  }> | null;
};

function extractStreamDelta(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (typeof chunk === "object" && chunk !== null) {
    const response = (chunk as { response?: unknown }).response;
    if (typeof response === "string") {
      return response;
    }
    const choices = (chunk as StreamChunk).choices;
    const content = choices?.[0]?.delta?.content;
    if (typeof content === "string") {
      return content;
    }
  }
  return "";
}

function decodeStreamChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  async function* iterate(): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        pending += decoder.decode(value, { stream: true });
        let newlineIndex = pending.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex).trim();
          pending = pending.slice(newlineIndex + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload && payload !== "[DONE]") {
              try {
                const parsed = JSON.parse(payload) as unknown;
                const delta = extractStreamDelta(parsed);
                if (delta.length > 0) {
                  yield delta;
                }
              } catch {
                // Skip malformed SSE lines.
              }
            }
          }
          newlineIndex = pending.indexOf("\n");
        }
      }
      const trailing = pending.trim();
      if (trailing.startsWith("data:")) {
        const payload = trailing.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const parsed = JSON.parse(payload) as unknown;
            const delta = extractStreamDelta(parsed);
            if (delta.length > 0) {
              yield delta;
            }
          } catch {
            // Skip malformed SSE lines.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  return iterate();
}

export async function* streamAssistantTextWithWorkersAi(
  messages: ConversationMessage[],
  ai: WorkersAiBinding | undefined,
  abortSignal: AbortSignal,
): AsyncGenerator<string> {
  const binding = assertBinding(ai);
  const response = await binding.run(
    WORKERS_AI_TEXT_MODEL,
    {
      messages,
      stream: true,
      max_tokens: MAX_COMPLETION_TOKENS,
    },
    { signal: abortSignal },
  );

  if (response instanceof ReadableStream || (response && typeof (response as ReadableStream).getReader === "function")) {
    yield* decodeStreamChunks(response as ReadableStream<Uint8Array>);
    return;
  }

  if (typeof response === "string") {
    if (response.length > 0) {
      yield response;
    }
    return;
  }

  for await (const chunk of (response ?? []) as AsyncIterable<unknown>) {
    if (abortSignal.aborted) {
      return;
    }
    const delta = extractStreamDelta(chunk);
    if (delta.length > 0) {
      yield delta;
    }
  }
}

function buildPlannerToolParameters(toolName: string): JsonSchema {
  switch (toolName) {
    case "add_menu_item":
      return {
        type: "object",
        properties: {
          item: { type: "string", description: "Menu item name." },
          quantity: { type: "number", description: "Quantity to add. Default 1." },
        },
        required: ["item"],
        additionalProperties: false,
      };
    case "remove_menu_item":
      return {
        type: "object",
        properties: {
          item: { type: "string", description: "Menu item name." },
          quantity: { type: "number", description: "Quantity to remove. Default 1." },
        },
        required: ["item"],
        additionalProperties: false,
      };
    case "get_order_total":
    case "check_availability":
      return {
        type: "object",
        properties: {},
        additionalProperties: false,
      };
    case "submit_order":
      return {
        type: "object",
        properties: {},
        additionalProperties: false,
      };
    case "create_reservation":
      return {
        type: "object",
        properties: {
          date: { type: "string", description: "Reservation date." },
          time: { type: "string", description: "Reservation time." },
          partySize: { type: "number", description: "Number of guests." },
          name: { type: "string", description: "Guest name." },
        },
        required: ["date", "time", "partySize"],
        additionalProperties: false,
      };
    case "update_reservation":
      return {
        type: "object",
        properties: {
          reservationId: { type: "string", description: "Reservation identifier." },
          date: { type: "string", description: "Updated date." },
          time: { type: "string", description: "Updated time." },
          partySize: { type: "number", description: "Updated party size." },
        },
        required: ["reservationId"],
        additionalProperties: false,
      };
    case "cancel_reservation":
      return {
        type: "object",
        properties: {
          reservationId: { type: "string", description: "Reservation identifier." },
        },
        required: ["reservationId"],
        additionalProperties: false,
      };
    case "lookup_order":
      return {
        type: "object",
        properties: {
          orderId: { type: "string", description: "Order identifier." },
        },
        required: ["orderId"],
        additionalProperties: false,
      };
    case "start_return":
      return {
        type: "object",
        properties: {
          orderId: { type: "string", description: "Order identifier." },
          reason: { type: "string", description: "Return reason." },
        },
        required: ["orderId"],
        additionalProperties: false,
      };
    case "update_shipping_address":
      return {
        type: "object",
        properties: {
          orderId: { type: "string", description: "Order identifier." },
          city: { type: "string", description: "Updated city." },
        },
        required: ["orderId", "city"],
        additionalProperties: false,
      };
    case "escalate_to_human":
      return {
        type: "object",
        properties: {
          reason: { type: "string", description: "Reason for escalation." },
        },
        additionalProperties: false,
      };
    default:
      return {
        type: "object",
        properties: {},
        additionalProperties: true,
      };
  }
}

function buildSubmitActionsParameters(toolNames: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: { type: "string" },
            args: { type: "object", properties: {} },
          },
          required: ["tool"],
          additionalProperties: true,
        },
      },
    },
    required: ["actions"],
    additionalProperties: false,
  };
}

function buildPlannerTools(toolNames: string[]) {
  return [
    {
      type: "function" as const,
      function: {
        name: "submit_actions",
        description: "Return the complete list of background actions for this turn.",
        parameters: buildSubmitActionsParameters(toolNames),
      },
    },
  ];
}

function parseToolArguments(raw: string | null | undefined, context: string): Record<string, unknown> {
  const text = raw?.trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Workers AI ${context} returned invalid JSON arguments.`);
  }
}

function normalizeBackgroundActions(value: unknown): BackgroundToolPlanAction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const actions: BackgroundToolPlanAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const tool = (entry as { tool?: unknown }).tool;
    if (typeof tool !== "string" || tool.trim().length === 0) {
      continue;
    }
    const args = (entry as { args?: unknown }).args;
    actions.push({
      tool: tool.trim(),
      args: typeof args === "object" && args !== null ? { ...(args as Record<string, unknown>) } : {},
    });
  }
  return actions;
}

export async function generateBackgroundToolPlanWithWorkersAi(
  messages: ConversationMessage[],
  toolNames: string[],
  ai: WorkersAiBinding | undefined,
  abortSignal: AbortSignal,
): Promise<BackgroundToolPlanFromNativeCalls> {
  const binding = assertBinding(ai);
  if (toolNames.length === 0) {
    return {
      actions: [],
      toolCallCount: 0,
      messageContent: "",
    };
  }

  let payload: WorkersAiChatResponse | undefined;
  // Upstream occasionally returns an empty payload; one retry recovers.
  for (let attempt = 0; attempt < 2; attempt++) {
    payload = (await binding.run(
      WORKERS_AI_TOOL_PLAN_MODEL,
      {
        messages,
        tools: buildPlannerTools(toolNames),
        max_tokens: 512,
      },
      { signal: abortSignal },
    )) as WorkersAiChatResponse;
    if (payload?.choices?.[0]?.message || abortSignal.aborted) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const message = payload?.choices?.[0]?.message;
  if (!message) {
    throw new Error("Workers AI tool-plan response did not include a message.");
  }

  const toolCalls = message.tool_calls ?? [];
  const submitActionsCall = toolCalls.find((toolCall) => toolCall.function?.name?.trim() === "submit_actions");
  const submitActionsArgs = submitActionsCall
    ? parseToolArguments(submitActionsCall.function?.arguments, "submit_actions")
    : {};
  let actions = normalizeBackgroundActions(submitActionsArgs.actions);

  const contentText = message.content?.trim() ?? "";
  if (actions.length === 0 && contentText.length > 0) {
    // gpt-oss-20b on Workers AI often answers with the JSON payload in `content`
    // even when tools are provided; accept it as a fallback shape.
    try {
      const parsed = JSON.parse(contentText) as unknown;
      actions = normalizeBackgroundActions(
        typeof parsed === "object" && parsed !== null ? (parsed as { actions?: unknown }).actions : undefined,
      );
    } catch {
      // Content was not a JSON action list; keep empty actions.
    }
  }

  return {
    actions,
    toolCallCount: toolCalls.length,
    messageContent: contentText,
  };
}
