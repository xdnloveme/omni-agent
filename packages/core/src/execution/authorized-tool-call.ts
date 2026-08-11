import type { RegisteredAgentTool } from "../types";
import type { AuthorizedToolCall, ToolExecutionContext } from "./types";

export function createAuthorizedToolCall(
  tool: RegisteredAgentTool,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): AuthorizedToolCall {
  return {
    tool,
    input: freezeDeep(structuredClone(input)),
    context: Object.freeze({ ...context }),
  } as AuthorizedToolCall;
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeDeep(nested);
  return Object.freeze(value);
}
