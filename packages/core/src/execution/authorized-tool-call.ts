import type { RegisteredAgentTool } from "../types";
import { cloneData, freezeData } from "../dataCopy";
import type { AuthorizedToolCall, ToolExecutionContext, ToolExecutionPlan } from "./types";

export function createAuthorizedToolCall(
  tool: RegisteredAgentTool,
  input: Readonly<Record<string, unknown>>,
  context: ToolExecutionContext,
  executionPlan: ToolExecutionPlan,
): AuthorizedToolCall {
  return {
    tool,
    input: freezeData(cloneData(input)),
    context: Object.freeze({ ...context }),
    executionPlan: freezeData(cloneData(executionPlan)),
  } as AuthorizedToolCall;
}
