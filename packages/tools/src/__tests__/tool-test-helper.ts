import type { AgentToolDefinition, ToolExecutionContext } from "@omni-agent/core";

export async function invokeToolImplementation(
  tool: AgentToolDefinition,
  input: Record<string, unknown>,
  context: ToolExecutionContext = { cwd: process.cwd() },
) {
  const binder = tool.authorization.kind === "dynamic" ? tool.authorization.bindInput : undefined;
  const executionInput = binder
    ? await binder(structuredClone(input), {
        cwd: context.cwd,
        agentId: "test",
        toolIdentity: `test:${tool.name}`,
        toolCallId: "test-call",
        signal: context.signal,
      })
    : input;
  return tool.execute(executionInput, context);
}

export function invokeUnboundToolImplementation(
  tool: AgentToolDefinition,
  input: Record<string, unknown>,
  context: ToolExecutionContext = { cwd: process.cwd() },
) {
  return tool.execute(input, context);
}
