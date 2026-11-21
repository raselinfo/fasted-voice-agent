import { z } from "zod";

const backgroundToolActionSchema = z
  .object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

const backgroundToolPlanSchema = z
  .object({
    actions: z.array(backgroundToolActionSchema),
  })
  .strict();

export type BackgroundToolAction = z.infer<typeof backgroundToolActionSchema>;
export type BackgroundToolPlan = z.infer<typeof backgroundToolPlanSchema>;

export type BackgroundToolExecutor = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type BackgroundToolRegistry = Record<string, BackgroundToolExecutor>;

export type BackgroundActionExecutionResult = {
  tool: string;
  args: Record<string, unknown>;
  ok: true;
  output: unknown;
};

export type BackgroundActionExecutionFailure = {
  tool: string;
  args: Record<string, unknown>;
  ok: false;
  error: string;
};

export type BackgroundActionExecution = BackgroundActionExecutionResult | BackgroundActionExecutionFailure;

export type NormalizedFollowup =
  | {
      kind: "pass";
    }
  | {
      kind: "text";
      text: string;
    };

const MAX_FOLLOWUP_CHARS = 240;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseStrictToolPlan(candidate: string): BackgroundToolPlan | null {
  let payload: unknown;
  try {
    payload = JSON.parse(candidate);
  } catch {
    return null;
  }

  const parsed = backgroundToolPlanSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

export function parseToolPlan(candidate: string): BackgroundToolPlan | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  return parseStrictToolPlan(trimmed);
}

export async function executeAllowlistedActions(
  actions: BackgroundToolAction[],
  registry: BackgroundToolRegistry,
): Promise<BackgroundActionExecution[]> {
  const results: BackgroundActionExecution[] = [];

  for (const action of actions) {
    const executor = registry[action.tool];
    if (!executor) {
      results.push({
        tool: action.tool,
        args: action.args,
        ok: false,
        error: `Unknown tool: ${action.tool}`,
      });
      continue;
    }

    try {
      const output = await executor(action.args);
      results.push({
        tool: action.tool,
        args: action.args,
        ok: true,
        output,
      });
    } catch (error) {
      results.push({
        tool: action.tool,
        args: action.args,
        ok: false,
        error: getErrorMessage(error),
      });
    }
  }

  return results;
}

export function normalizeFollowupCandidate(candidate: string): NormalizedFollowup {
  const trimmed = candidate.trim();
  if (trimmed.toLowerCase() === "[pass]" || trimmed === "[[PASS]]") {
    return { kind: "pass" };
  }

  if (!trimmed) {
    return { kind: "pass" };
  }

  if (trimmed.length <= MAX_FOLLOWUP_CHARS) {
    return { kind: "text", text: trimmed };
  }

  return { kind: "text", text: `${trimmed.slice(0, MAX_FOLLOWUP_CHARS - 3).trimEnd()}...` };
}
