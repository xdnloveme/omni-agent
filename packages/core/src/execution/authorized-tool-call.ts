import type { RegisteredAgentTool } from "../types";
import type { AuthorizedToolCall, ToolExecutionContext, ToolExecutionPlan } from "./types";

export function createAuthorizedToolCall(
  tool: RegisteredAgentTool,
  input: Readonly<Record<string, unknown>>,
  context: ToolExecutionContext,
  executionPlan: ToolExecutionPlan,
): AuthorizedToolCall {
  return {
    tool,
    input: freezeDeep(structuredClone(input)),
    context: Object.freeze({ ...context }),
    executionPlan: freezeDeep(structuredClone(executionPlan)),
  } as AuthorizedToolCall;
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeDeep(nested);
  return Object.freeze(value);
}
