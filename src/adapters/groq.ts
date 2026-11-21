import { jsonrepair } from "jsonrepair";
import type { ConversationMessage } from "../providers/contracts";

export type { ConversationMessage } from "../providers/contracts";

type GroqChatChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: {
          name?: string | null;
        } | null;
      }> | null;
    };
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: {
          name?: string | null;
        } | null;
      }> | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    queue_time?: number;
    prompt_time?: number;
    completion_time?: number;
    total_time?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

type GroqChatCompletionResponse = {
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

type GroqErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    failed_generation?: string;
    status_code?: number;
  };
};

type GroqErrorDetails = {
  code: string;
  failedGeneration?: string;
  preview: string;
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

export class GroqRateLimitError extends Error {
  readonly status: number;

  constructor(message = "Groq request failed with status 429.") {
    super(message);
    this.name = "GroqRateLimitError";
    this.status = 429;
  }
}

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODEL: string = "meta-llama/llama-4-scout-17b-16e-instruct";
// Previous default:
// export const GROQ_MODEL: string = "openai/gpt-oss-120b";
export const GROQ_TOOL_PLAN_MODEL: string = "openai/gpt-oss-20b";
const GROQ_MAIN_AGENT_MAX_COMPLETION_TOKENS = 128;
const GROQ_REQUEST_TIMEOUT_MS = 20_000;

function formatErrorBodyPreview(rawBody: string): string {
  return rawBody.replace(/\s+/g, " ").slice(0, 500);
}

function buildGroqModelOptions(
  model: string,
  mode: "stream" | "tool-plan",
): {
  include_reasoning?: boolean;
  reasoning_effort?: string;
  reasoning_format?: string;
  stream_options?: {
    include_usage: boolean;
  };
} {
  if (model === "qwen/qwen3-32b") {
    return {
      reasoning_effort: "none",
      reasoning_format: "hidden",
      ...(mode === "stream"
        ? {
            stream_options: {
              include_usage: true,
            },
          }
        : {}),
    };
  }

  // Previous 120b-compatible options are kept for reference.
  // if (model === "openai/gpt-oss-20b" || model === "openai/gpt-oss-120b") {
  //   return {
  //     include_reasoning: false,
  //     ...(mode === "stream"
  //       ? {
  //           stream_options: {
  //             include_usage: true,
  //           },
  //         }
  //       : {}),
  //   };
  // }

  if (model === "openai/gpt-oss-20b") {
    return {
      include_reasoning: false,
      ...(mode === "stream"
        ? {
            stream_options: {
              include_usage: true,
            },
          }
        : {}),
    };
  }

  return mode === "stream"
    ? {
        stream_options: {
          include_usage: true,
        },
      }
    : {};
}

function buildGroqRequestBody(messages: ConversationMessage[]) {
  return {
    model: GROQ_MODEL,
    messages,
    stream: true,
    max_completion_tokens: GROQ_MAIN_AGENT_MAX_COMPLETION_TOKENS,
    ...buildGroqModelOptions(GROQ_MODEL, "stream"),
  };
}

function buildGroqToolPlanRequestBody(messages: ConversationMessage[], toolNames: string[]) {
  return {
    model: GROQ_TOOL_PLAN_MODEL,
    messages,
    tools: buildPlannerTools(toolNames),
    tool_choice: "auto",
    ...buildGroqModelOptions(GROQ_TOOL_PLAN_MODEL, "tool-plan"),
  };
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error("Groq request timed out.")), timeoutMs);
  timeoutController.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return timeoutController.signal;
}

function mergeAbortSignals(primary: AbortSignal, secondary: AbortSignal): AbortSignal {
  const mergedController = new AbortController();

  const abortFrom = (source: AbortSignal) => {
    if (!mergedController.signal.aborted) {
      mergedController.abort(source.reason);
    }
  };

  if (primary.aborted) {
    abortFrom(primary);
  }
  if (secondary.aborted) {
    abortFrom(secondary);
  }

  primary.addEventListener("abort", () => abortFrom(primary), { once: true });
  secondary.addEventListener("abort", () => abortFrom(secondary), { once: true });

  return mergedController.signal;
}

function splitSseBuffer(buffer: string): { completeBlocks: string[]; remainder: string } {
  const parts = buffer.split("\n\n");
  return {
    completeBlocks: parts.slice(0, -1),
    remainder: parts.at(-1) ?? "",
  };
}

function extractSseData(block: string): string | null {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"));

  if (lines.length === 0) {
    return null;
  }

  return lines.map((line) => line.slice(5).trimStart()).join("\n");
}

export async function* streamAssistantText(
  messages: ConversationMessage[],
  apiKey: string | undefined,
  abortSignal: AbortSignal,
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
): AsyncGenerator<string> {
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY.");
  }

  const timeoutSignal = createTimeoutSignal(GROQ_REQUEST_TIMEOUT_MS);
  const signal = mergeAbortSignals(abortSignal, timeoutSignal);
  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildGroqRequestBody(messages)),
    signal,
  });

  if (!response.ok) {
    const errorBody = (await response.text()).trim();
    const errorBodyPreview = formatErrorBodyPreview(errorBody);
    if (response.status === 429) {
      throw new GroqRateLimitError(
        `Groq request failed with status 429.${errorBodyPreview ? ` body=${errorBodyPreview}` : ""}`,
      );
    }
    throw new Error(
      `Groq request failed with status ${response.status}.${errorBodyPreview ? ` body=${errorBodyPreview}` : ""}`,
    );
  }

  if (!response.body) {
    throw new Error("Groq stream did not include a response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let yieldedText = false;
  let sawUsage = false;
  let sseBlockCount = 0;
  const finishReasons = new Set<string>();
  const toolCallNames = new Set<string>();
  let lastDataPreview = "";

  const captureChunkDiagnostics = (payload: GroqChatChunk) => {
    const choice = payload.choices?.[0];
    const finishReason = choice?.finish_reason?.trim();
    if (finishReason) {
      finishReasons.add(finishReason);
    }

    const deltaToolCalls = choice?.delta?.tool_calls ?? [];
    const messageToolCalls = choice?.message?.tool_calls ?? [];
    for (const toolCall of [...deltaToolCalls, ...messageToolCalls]) {
      const name = toolCall?.function?.name?.trim();
      if (name) {
        toolCallNames.add(name);
      }
    }
  };

  const maybeThrowIfNoText = () => {
    if (yieldedText) {
      return;
    }

    const finishReasonSummary = Array.from(finishReasons).join(",") || "none";
    const toolCallSummary = Array.from(toolCallNames).join(",") || "none";
    const lastDataSummary = lastDataPreview || "none";
    throw new Error(
      `Groq response did not include assistant text. finish_reasons=${finishReasonSummary}; tool_calls=${toolCallSummary}; tools_requested=false; sse_blocks=${sseBlockCount}; saw_usage=${sawUsage}; last_data=${lastDataSummary}`,
    );
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    pending += decoder.decode(value, { stream: true });
    const { completeBlocks, remainder } = splitSseBuffer(pending);
    pending = remainder;

    for (const block of completeBlocks) {
      const data = extractSseData(block);
      if (!data || data === "[DONE]") {
        continue;
      }

      sseBlockCount += 1;
      lastDataPreview = formatErrorBodyPreview(data);
      const payload = JSON.parse(data) as GroqChatChunk;
      captureChunkDiagnostics(payload);
      if (payload.usage) {
        sawUsage = true;
        onUsage?.({
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
          cachedTokens: payload.usage.prompt_tokens_details?.cached_tokens,
          queueTime: payload.usage.queue_time,
          promptTime: payload.usage.prompt_time,
          completionTime: payload.usage.completion_time,
          totalTime: payload.usage.total_time,
        });
      }
      const text = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? "";
      if (text) {
        yieldedText = true;
        yield text;
      }
    }
  }

  pending += decoder.decode();
  if (pending.trim().length > 0) {
    const data = extractSseData(pending);
    if (data && data !== "[DONE]") {
      sseBlockCount += 1;
      lastDataPreview = formatErrorBodyPreview(data);
      const payload = JSON.parse(data) as GroqChatChunk;
      captureChunkDiagnostics(payload);
      if (payload.usage) {
        sawUsage = true;
        onUsage?.({
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
          cachedTokens: payload.usage.prompt_tokens_details?.cached_tokens,
          queueTime: payload.usage.queue_time,
          promptTime: payload.usage.prompt_time,
          completionTime: payload.usage.completion_time,
          totalTime: payload.usage.total_time,
        });
      }
      const text = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? "";
      if (text) {
        yieldedText = true;
        yield text;
      }
    }
  }

  maybeThrowIfNoText();
}

export async function generateAssistantText(
  messages: ConversationMessage[],
  apiKey: string | undefined,
  abortSignal: AbortSignal,
): Promise<string> {
  let fullText = "";
  for await (const chunk of streamAssistantText(messages, apiKey, abortSignal)) {
    fullText += chunk;
  }

  const content = fullText.trim();
  if (!content) {
    throw new Error("Groq response did not include assistant text.");
  }

  return content;
}

function parseToolArguments(rawArguments: string | null | undefined, toolName: string): Record<string, unknown> {
  if (!rawArguments || rawArguments.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(rawArguments));
    } catch {
      const preview = rawArguments.replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`Groq tool call "${toolName}" returned invalid JSON arguments: ${preview}`);
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Groq tool call "${toolName}" arguments must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function parseJsonObjectWithRepair(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(raw));
    } catch {
      const preview = raw.replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`${label} returned invalid JSON: ${preview}`);
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function normalizeBackgroundActions(rawActions: unknown): BackgroundToolPlanAction[] {
  const parsedActions = Array.isArray(rawActions) ? rawActions : [];
  const actions: BackgroundToolPlanAction[] = [];

  for (const action of parsedActions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error("Groq submit_actions call included an invalid action entry.");
    }

    const tool = typeof action.tool === "string" ? action.tool.trim() : "";
    const args = action.args;
    if (!tool) {
      throw new Error("Groq submit_actions call included an action without a tool name.");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`Groq submit_actions call included invalid args for "${tool}".`);
    }

    actions.push({
      tool,
      args: args as Record<string, unknown>,
    });
  }

  return actions;
}

function parseGroqErrorDetails(errorBody: string): GroqErrorDetails | null {
  let payload: GroqErrorResponse;
  try {
    payload = JSON.parse(errorBody) as GroqErrorResponse;
  } catch {
    return null;
  }

  const code = payload.error?.code?.trim();
  if (!code) {
    return null;
  }

  return {
    code,
    failedGeneration: payload.error?.failed_generation,
    preview: formatErrorBodyPreview(errorBody),
  };
}

function trySalvageToolUseFailed(errorBody: string): BackgroundToolPlanFromNativeCalls | null {
  const errorDetails = parseGroqErrorDetails(errorBody);
  if (errorDetails?.code !== "tool_use_failed" || !errorDetails.failedGeneration) {
    return null;
  }

  let failedGeneration: Record<string, unknown>;
  try {
    failedGeneration = parseJsonObjectWithRepair(errorDetails.failedGeneration, "Groq failed_generation");
  } catch {
    return null;
  }

  const functionName = typeof failedGeneration.name === "string" ? failedGeneration.name.trim() : "";
  if (functionName !== "submit_actions") {
    return null;
  }

  const rawArguments = failedGeneration.arguments;
  let submitActionsArgs: Record<string, unknown>;
  try {
    submitActionsArgs =
      typeof rawArguments === "string"
        ? parseToolArguments(rawArguments, "submit_actions")
        : rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
          ? (rawArguments as Record<string, unknown>)
          : {};
  } catch {
    return null;
  }

  return {
    actions: normalizeBackgroundActions(submitActionsArgs.actions),
    toolCallCount: 1,
    messageContent: "",
  };
}

function buildRetryMessages(messages: ConversationMessage[], errorDetails: GroqErrorDetails): ConversationMessage[] {
  const failedGenerationPreview = (errorDetails.failedGeneration ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 400);

  return [
    ...messages,
    {
      role: "user",
      content:
        `Your previous submit_actions call was invalid and could not be parsed. Retry now with exactly one submit_actions call and valid JSON arguments only. ` +
        `Return the full actions array for the turn. Previous failed generation: ${failedGenerationPreview}`,
    },
  ];
}

type JsonSchema = Record<string, unknown>;

function buildPlannerToolParameters(toolName: string): JsonSchema {
  switch (toolName) {
    case "add_menu_item":
    case "remove_menu_item":
      return {
        type: "object",
        properties: {
          item: {
            type: "string",
            description: "Menu item name.",
          },
          quantity: {
            type: "integer",
            minimum: 1,
            description: "Number of items to add or remove.",
          },
        },
        required: ["item"],
        additionalProperties: false,
      };
    case "get_order_total":
    case "submit_order":
      return {
        type: "object",
        properties: {},
        additionalProperties: false,
      };
    case "check_availability":
      return {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Requested reservation date or natural-language date.",
          },
          partySize: {
            type: "integer",
            minimum: 1,
            description: "Number of guests.",
          },
        },
        additionalProperties: false,
      };
    case "create_reservation":
      return {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Guest name for the reservation.",
          },
          date: {
            type: "string",
            description: "Reservation date or natural-language date.",
          },
          time: {
            type: "string",
            description: "Reservation time.",
          },
          partySize: {
            type: "integer",
            minimum: 1,
            description: "Number of guests.",
          },
        },
        additionalProperties: false,
      };
    case "update_reservation":
      return {
        type: "object",
        properties: {
          confirmationCode: {
            type: "string",
            description: "Reservation confirmation code.",
          },
          name: {
            type: "string",
            description: "Updated guest name.",
          },
          date: {
            type: "string",
            description: "Updated reservation date.",
          },
          time: {
            type: "string",
            description: "Updated reservation time.",
          },
          partySize: {
            type: "integer",
            minimum: 1,
            description: "Updated party size.",
          },
        },
        required: ["confirmationCode"],
        additionalProperties: false,
      };
    case "cancel_reservation":
      return {
        type: "object",
        properties: {
          confirmationCode: {
            type: "string",
            description: "Reservation confirmation code.",
          },
        },
        required: ["confirmationCode"],
        additionalProperties: false,
      };
    case "lookup_order":
      return {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "Order identifier.",
          },
        },
        required: ["orderId"],
        additionalProperties: false,
      };
    case "start_return":
      return {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "Order identifier.",
          },
          item: {
            type: "string",
            description: "Item to return.",
          },
        },
        required: ["orderId", "item"],
        additionalProperties: false,
      };
    case "update_shipping_address":
      return {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "Order identifier.",
          },
          city: {
            type: "string",
            description: "Updated city.",
          },
        },
        required: ["orderId", "city"],
        additionalProperties: false,
      };
    case "escalate_to_human":
      return {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Reason for escalation.",
          },
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
          oneOf: toolNames.map((toolName) => ({
            type: "object",
            properties: {
              tool: {
                type: "string",
                const: toolName,
              },
              args: buildPlannerToolParameters(toolName),
            },
            required: ["tool", "args"],
            additionalProperties: false,
          })),
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

export async function generateBackgroundToolPlanWithNativeCalls(
  messages: ConversationMessage[],
  toolNames: string[],
  apiKey: string | undefined,
  abortSignal: AbortSignal,
): Promise<BackgroundToolPlanFromNativeCalls> {
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY.");
  }

  if (toolNames.length === 0) {
    return {
      actions: [],
      toolCallCount: 0,
      messageContent: "",
    };
  }

  const timeoutSignal = createTimeoutSignal(GROQ_REQUEST_TIMEOUT_MS);
  const signal = mergeAbortSignals(abortSignal, timeoutSignal);
  const requestPlan = async (requestMessages: ConversationMessage[]) =>
    fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGroqToolPlanRequestBody(requestMessages, toolNames)),
      signal,
    });

  let response = await requestPlan(messages);

  if (!response.ok) {
    let errorBody = (await response.text()).trim();
    let errorBodyPreview = errorBody.replace(/\s+/g, " ").slice(0, 500);
    if (response.status === 429) {
      throw new GroqRateLimitError(
        `Groq native tool-plan request failed with status 429.${errorBodyPreview ? ` body=${errorBodyPreview}` : ""}`,
      );
    }
    let salvaged = response.status === 400 ? trySalvageToolUseFailed(errorBody) : null;
    if (salvaged) {
      return salvaged;
    }
    const errorDetails = response.status === 400 ? parseGroqErrorDetails(errorBody) : null;
    if (response.status === 400 && errorDetails?.code === "tool_use_failed") {
      response = await requestPlan(buildRetryMessages(messages, errorDetails));
      if (!response.ok) {
        errorBody = (await response.text()).trim();
        errorBodyPreview = errorBody.replace(/\s+/g, " ").slice(0, 500);
        salvaged = trySalvageToolUseFailed(errorBody);
        if (salvaged) {
          return salvaged;
        }
      }
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new GroqRateLimitError(
          `Groq native tool-plan request failed with status 429.${errorBodyPreview ? ` body=${errorBodyPreview}` : ""}`,
        );
      }
      throw new Error(
        `Groq native tool-plan request failed with status ${response.status}.${errorBodyPreview ? ` body=${errorBodyPreview}` : ""}`,
      );
    }
  }

  const payload = (await response.json()) as GroqChatCompletionResponse;
  const message = payload.choices?.[0]?.message;
  if (!message) {
    throw new Error("Groq native tool-plan response did not include a message.");
  }

  const toolCalls = message.tool_calls ?? [];
  const submitActionsCall = toolCalls.find((toolCall) => toolCall.function?.name?.trim() === "submit_actions");
  const submitActionsArgs = submitActionsCall
    ? parseToolArguments(submitActionsCall.function?.arguments, "submit_actions")
    : {};
  const actions = normalizeBackgroundActions(submitActionsArgs.actions);

  return {
    actions,
    toolCallCount: toolCalls.length,
    messageContent: message.content?.trim() ?? "",
  };
}
