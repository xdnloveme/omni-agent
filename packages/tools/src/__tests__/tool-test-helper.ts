import type { AgentToolDefinition, ToolExecutionContext } from "@omni-agent/core";

export function invokeToolImplementation(
  tool: AgentToolDefinition,
  input: Record<string, unknown>,
  context: ToolExecutionContext = { cwd: process.cwd() },
) {
  return tool.execute(input, context);
}
