import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type BackgroundToolRegistry,
  executeAllowlistedActions,
  normalizeFollowupCandidate,
  parseToolPlan,
} from "../../src/durable/background-tool-lane";
import { serverMessageSchema } from "../../src/protocol/messages";
import type { ConversationMessage, ProviderRuntime } from "../../src/providers/contracts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

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
}

function parseSentMessages(socket: CapturingSocket) {
  return socket.sentStrings.map((payload) => serverMessageSchema.parse(JSON.parse(payload)));
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

type SessionDOProbe = {
  activeSocket: WebSocket | null;
  activeSessionId: string | null;
  state: "idle" | "listening" | "thinking" | "speaking" | "interrupted" | "error";
  lastAcceptedAudioChunkSequence: number | null;
  providerRuntime?: ProviderRuntime | null;
  backgroundToolRegistryOverride?: BackgroundToolRegistry | null;
  backgroundHistory?: Array<{ role: "user" | "assistant"; content: string; turnId: number; origin: string }>;
  backgroundTurnResults?: Map<
    number,
    {
      turnId: number;
      status: string;
      actions: unknown[];
      error?: string;
      updatedAt: string;
    }
  >;
  deferredFollowupIngestion?: Array<{ turnId: number; content: string }>;
  handleEndOfTurn(finalTranscript: string): Promise<void>;
};

function cloneMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((message) => ({ ...message }));
}

function createFakeRuntime(
  callLog: ConversationMessage[][],
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
        callLog.push(cloneMessages(messages));
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

async function createSession(socket: WebSocket, providerRuntime: ProviderRuntime): Promise<SessionDOProbe> {
  const { SessionDO } = await import("../../src/durable/session-do");
  const session = Object.create(SessionDO.prototype) as SessionDOProbe;
  session.activeSocket = socket;
  session.activeSessionId = "async-background-lane";
  session.state = "listening";
  session.lastAcceptedAudioChunkSequence = null;
  session.providerRuntime = providerRuntime;
  return session;
}

afterEach(() => {
  vi.resetModules();
});

describe("Async background lane strict parse and sentinel", () => {
  it("accepts only strict tool plan JSON and rejects unknown keys", () => {
    expect(
      parseToolPlan(
        JSON.stringify({
          actions: [{ tool: "add_item", args: { sku: "milk", qty: 1 } }],
        }),
      ),
    ).toEqual({
      actions: [{ tool: "add_item", args: { sku: "milk", qty: 1 } }],
    });

    expect(
      parseToolPlan(
        JSON.stringify({
          actions: [{ tool: "add_item", args: { sku: "milk", qty: 1 } }],
          unexpected: true,
        }),
      ),
    ).toBeNull();

    expect(
      parseToolPlan(
        JSON.stringify({
          actions: [{ tool: "add_item", args: { sku: "milk", qty: 1 }, extra: "nope" }],
        }),
      ),
    ).toBeNull();
  });

  it("rejects non-strict wrappers and non-object shapes", () => {
    expect(
      parseToolPlan(
        "```json\n{\"actions\":[{\"tool\":\"add_item\",\"args\":{\"item\":\"milk\",\"quantity\":1}}]}\n```",
      ),
    ).toBeNull();

    expect(
      parseToolPlan(
        "Here is the plan:\n{\"actions\":[{\"tool\":\"get_cart_total\",\"args\":{}}]}",
      ),
    ).toBeNull();

    expect(
      parseToolPlan(
        "[{\"tool\":\"add_item\",\"args\":{\"item\":\"milk\",\"quantity\":1}}]",
      ),
    ).toBeNull();
  });

  it("executes allowlisted tools and reports unknown tools as safe failures", async () => {
    const results = await executeAllowlistedActions(
      [
        { tool: "add_item", args: { sku: "milk", qty: 1 } },
        { tool: "unknown_tool", args: { anything: true } },
      ],
      {
        add_item: async (args) => ({ added: String(args.sku), qty: args.qty ?? 1 }),
      },
    );

    expect(results).toEqual([
      {
        tool: "add_item",
        args: { sku: "milk", qty: 1 },
        ok: true,
        output: { added: "milk", qty: 1 },
      },
      {
        tool: "unknown_tool",
        args: { anything: true },
        ok: false,
        error: "Unknown tool: unknown_tool",
      },
    ]);
  });

  it("normalizes follow-up output with [pass] semantics and still accepts legacy [[PASS]]", () => {
    expect(normalizeFollowupCandidate("  [pass]\n")).toEqual({ kind: "pass" });
    expect(normalizeFollowupCandidate("  [[PASS]]\n")).toEqual({ kind: "pass" });

    expect(normalizeFollowupCandidate("[[PASS]] not exact")).toEqual({
      kind: "text",
      text: "[[PASS]] not exact",
    });

    expect(normalizeFollowupCandidate("   short update for the user   ")).toEqual({
      kind: "text",
      text: "short update for the user",
    });
  });
});

describe("Async background lane non-blocking and continuity", () => {
  it("emits turn.assistant.final before background tool execution completes", async () => {
    const callLog: ConversationMessage[][] = [];
    const toolRelease = createDeferred<void>();
    let toolStarted = false;

    const runtime = createFakeRuntime(callLog, [
      async function* () {
        yield "Primary answer.";
      },
      async function* () {
        yield JSON.stringify({
          actions: [{ tool: "add_item", args: { sku: "milk", qty: 1 } }],
        });
      },
      async function* () {
        yield "[pass]";
      },
    ]);

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, runtime);
    session.backgroundToolRegistryOverride = {
      add_item: async (args) => {
        toolStarted = true;
        await toolRelease.promise;
        return { added: args.sku, qty: args.qty };
      },
    };

    await session.handleEndOfTurn("Please add milk");

    const turnMessages = parseSentMessages(socket).filter((message) => message.type.startsWith("turn."));
    expect(turnMessages).toContainEqual({
      type: "turn.assistant.final",
      assistantTurnId: 1,
      text: "Primary answer.",
    });

    await waitFor(() => toolStarted);
    expect(session.backgroundTurnResults?.get(1)?.status).toMatch(/pending|in_progress/);

    toolRelease.resolve();
    await waitFor(() => session.backgroundTurnResults?.get(1)?.status === "completed");
  });

  it("runs background passes serially and keeps one continuous background history", async () => {
    const callLog: ConversationMessage[][] = [];
    const firstRelease = createDeferred<void>();
    const secondRelease = createDeferred<void>();
    const executionOrder: number[] = [];
    let activeExecutions = 0;
    let maxActiveExecutions = 0;

    const runtime = createFakeRuntime(callLog, [
      async function* () {
        yield "First answer.";
      },
      async function* () {
        yield JSON.stringify({
          actions: [{ tool: "slow_tool", args: { run: 1 } }],
        });
      },
      async function* () {
        yield "Second answer.";
      },
      async function* () {
        yield JSON.stringify({
          actions: [{ tool: "slow_tool", args: { run: 2 } }],
        });
      },
    ]);

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, runtime);
    session.backgroundToolRegistryOverride = {
      slow_tool: async (args) => {
        const run = Number(args.run);
        executionOrder.push(run);
        activeExecutions += 1;
        maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
        if (run === 1) {
          await firstRelease.promise;
        } else {
          await secondRelease.promise;
        }
        activeExecutions -= 1;
        return { run };
      },
    };

    await session.handleEndOfTurn("First user turn");
    await waitFor(() => executionOrder.length === 1);

    await session.handleEndOfTurn("Second user turn");
    await Promise.resolve();

    expect(executionOrder).toEqual([1]);
    expect(maxActiveExecutions).toBe(1);

    firstRelease.resolve();
    await waitFor(() => executionOrder.length === 2);
    expect(executionOrder).toEqual([1, 2]);

    secondRelease.resolve();
    await waitFor(() => session.backgroundTurnResults?.get(1)?.status === "completed");
    await waitFor(() => session.backgroundTurnResults?.get(2)?.status === "completed");

    const assistantPrimaryHistory = (session.backgroundHistory ?? []).filter((entry) => entry.origin === "assistant_primary");
    expect(assistantPrimaryHistory.map((entry) => [entry.turnId, entry.content])).toEqual([
      [1, "First answer."],
      [2, "Second answer."],
    ]);
  });

  it("persists turn-keyed results and injects hidden [turn N result] notes into later foreground prompts", async () => {
    const callLog: ConversationMessage[][] = [];
    const firstToolRelease = createDeferred<void>();
    let firstToolStarted = false;
    let planningCallCount = 0;

    const runtime: ProviderRuntime = {
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
        async *streamText(messages: ConversationMessage[], _signal: AbortSignal) {
          callLog.push(cloneMessages(messages));
          const firstContent = messages[0]?.content ?? "";

          if (firstContent.includes("background tool planner")) {
            planningCallCount += 1;
            if (planningCallCount === 1) {
              yield JSON.stringify({
                actions: [{ tool: "slow_tool", args: { sku: "milk" } }],
              });
              return;
            }

            yield JSON.stringify({ actions: [] });
            return;
          }

          if (firstContent.includes("You are the agent. You are shown a recent user turn")) {
            yield "[pass]";
            return;
          }

          const lastUserText = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
          if (lastUserText === "Turn one") {
            yield "First answer.";
            return;
          }
          if (lastUserText === "Turn two") {
            yield "Second answer.";
            return;
          }
          if (lastUserText === "Turn three") {
            yield "Third answer.";
            return;
          }

          yield "Fallback answer.";
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

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, runtime);
    session.backgroundToolRegistryOverride = {
      slow_tool: async () => {
        firstToolStarted = true;
        await firstToolRelease.promise;
        return { ok: true, sku: "milk" };
      },
    };

    await session.handleEndOfTurn("Turn one");
    await waitFor(() => firstToolStarted);

    await session.handleEndOfTurn("Turn two");

    const secondForegroundMessages =
      callLog.find(
        (messages) =>
          messages[0]?.content.includes("assistant speaking in real time") === true &&
          messages.some((message) => message.role === "user" && message.content === "Turn two"),
      ) ?? [];
    const secondForegroundContents = secondForegroundMessages.map((message) => message.content).join("\n");
    expect(secondForegroundContents).toContain("[turn 1 result]");
    expect(secondForegroundContents).toMatch(/pending|in_progress/);

    firstToolRelease.resolve();
    await waitFor(() => session.backgroundTurnResults?.get(1)?.status === "completed");

    await session.handleEndOfTurn("Turn three");

    const thirdForegroundMessages =
      callLog.find(
        (messages) =>
          messages[0]?.content.includes("assistant speaking in real time") === true &&
          messages.some((message) => message.role === "user" && message.content === "Turn three"),
      ) ?? [];
    const thirdForegroundContents = thirdForegroundMessages.map((message) => message.content).join("\n");
    expect(thirdForegroundContents).toContain("[turn 1 result]");
    expect(thirdForegroundContents).toContain("completed");
    expect(thirdForegroundContents).toContain("slow_tool");
  });

  it("uses a priced default drive-thru stub so add_menu_item and get_order_total return realistic totals", async () => {
    const callLog: ConversationMessage[][] = [];
    const runtime = createFakeRuntime(callLog, [
      async function* () {
        yield "Added items.";
      },
      async function* () {
        yield JSON.stringify({
          actions: [
            { tool: "add_menu_item", args: { item: "fries", quantity: 2 } },
            { tool: "add_menu_item", args: { item: "burger", quantity: 1 } },
          ],
        });
      },
      async function* () {
        yield "Checking total.";
      },
      async function* () {
        yield JSON.stringify({
          actions: [{ tool: "get_order_total", args: {} }],
        });
      },
    ]);

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, runtime);

    await session.handleEndOfTurn("Add fries and a burger");
    await waitFor(() => session.backgroundTurnResults?.get(1)?.status === "completed");

    await session.handleEndOfTurn("What's my order total?");
    await waitFor(() => session.backgroundTurnResults?.get(2)?.status === "completed");

    const turn1 = session.backgroundTurnResults?.get(1);
    const turn2 = session.backgroundTurnResults?.get(2);
    expect(turn1?.status).toBe("completed");
    expect(turn2?.status).toBe("completed");

    const getTotalResult = (turn2?.actions?.[0] ?? null) as
      | {
          ok: boolean;
          output?: {
            currency: string;
            totalGbp: number;
            itemCount: number;
            items: Array<{ item: string; quantity: number; unitPriceGbp: number; lineTotalGbp: number }>;
          };
        }
      | null;

    expect(getTotalResult?.ok).toBe(true);
    expect(getTotalResult?.output?.currency).toBe("GBP");
    expect(getTotalResult?.output?.itemCount).toBe(3);
    expect(getTotalResult?.output?.totalGbp).toBe(13.07);
    expect(getTotalResult?.output?.items).toEqual([
      { item: "burger", quantity: 1, unitPriceGbp: 6.49, lineTotalGbp: 6.49 },
      { item: "fries", quantity: 2, unitPriceGbp: 3.29, lineTotalGbp: 6.58 },
    ]);
  });
});

describe("Async background lane PASS semantics and deferred ingestion", () => {
  it("skips follow-up generation entirely when no tools ran", async () => {
    const callLog: ConversationMessage[][] = [];
    const runtime = createFakeRuntime(callLog, [
      async function* () {
        yield "Primary answer.";
      },
      async function* () {
        yield JSON.stringify({ actions: [] });
      },
    ]);

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, runtime);
    await session.handleEndOfTurn("Turn one");

    await waitFor(() => session.backgroundTurnResults?.get(1)?.status === "completed");

    const finalMessages = parseSentMessages(socket).filter((message) => message.type === "turn.assistant.final");
    expect(finalMessages).toEqual([
      {
        type: "turn.assistant.final",
        assistantTurnId: 1,
        text: "Primary answer.",
      },
    ]);
    expect(callLog).toHaveLength(2);
    expect(session.deferredFollowupIngestion ?? []).toHaveLength(0);
    expect((session.backgroundHistory ?? []).some((entry) => entry.origin === "assistant_followup")).toBe(false);
  });

  it("skips follow-up generation entirely when tools did run", async () => {
    const callLog: ConversationMessage[][] = [];
    const runtime = createFakeRuntime(callLog, [
      async function* () {
        yield "Primary answer.";
      },
      async function* () {
        yield JSON.stringify({ actions: [{ tool: "get_order_total", args: {} }] });
      },
    ]);

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, runtime);
    await session.handleEndOfTurn("Turn one");

    await waitFor(() => session.backgroundTurnResults?.get(1)?.status === "completed");

    const finalMessages = parseSentMessages(socket).filter((message) => message.type === "turn.assistant.final");
    expect(finalMessages).toEqual([
      {
        type: "turn.assistant.final",
        assistantTurnId: 1,
        text: "Primary answer.",
      },
    ]);
    expect(callLog).toHaveLength(2);
    expect(session.deferredFollowupIngestion ?? []).toHaveLength(0);
    expect((session.backgroundHistory ?? []).some((entry) => entry.origin === "assistant_followup")).toBe(false);
  });

  it("does not emit a follow-up even if a follow-up model output was queued in the fake runtime", async () => {
    const callLog: ConversationMessage[][] = [];
    const runtime = createFakeRuntime(callLog, [
      async function* () {
        yield "Primary answer.";
      },
      async function* () {
        yield JSON.stringify({ actions: [{ tool: "get_order_total", args: {} }] });
      },
      async function* () {
        yield "Short follow-up update.";
      },
    ]);

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, runtime);
    await session.handleEndOfTurn("Turn one");

    await waitFor(() => session.backgroundTurnResults?.get(1)?.status === "completed");

    const finalMessages = parseSentMessages(socket).filter((message) => message.type === "turn.assistant.final");
    expect(finalMessages.map((message) => message.text)).toEqual(["Primary answer."]);
    expect(callLog).toHaveLength(2);
    expect(session.deferredFollowupIngestion ?? []).toEqual([]);
    expect((session.backgroundHistory ?? []).some((entry) => entry.origin === "assistant_followup")).toBe(false);
  });

  it("does not ingest or replay any follow-up state on later user-driven cycles while disabled", async () => {
    const callLog: ConversationMessage[][] = [];
    const runtime = createFakeRuntime(callLog, [
      async function* () {
        yield "Primary answer one.";
      },
      async function* () {
        yield JSON.stringify({ actions: [{ tool: "get_order_total", args: {} }] });
      },
      async function* () {
        yield "Primary answer two.";
      },
      async function* () {
        yield JSON.stringify({ actions: [] });
      },
    ]);

    const socket = new CapturingSocket();
    const session = await createSession(socket as unknown as WebSocket, runtime);

    await session.handleEndOfTurn("Turn one");
    await waitFor(() => session.backgroundTurnResults?.get(1)?.status === "completed");

    expect(callLog).toHaveLength(2);

    await session.handleEndOfTurn("Turn two");
    await waitFor(() => session.backgroundTurnResults?.get(2)?.status === "completed");

    const secondBackgroundPlanContents = callLog[3]?.map((message) => message.content).join("\n") ?? "";
    expect(secondBackgroundPlanContents).not.toContain("[turn 1 assistant_followup]");
    expect(session.deferredFollowupIngestion ?? []).toHaveLength(0);
  });
});
