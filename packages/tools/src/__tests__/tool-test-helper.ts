import {
  isInProcessTool,
  isProcessTool,
  type AgentToolDefinition,
  type ToolExecutionContext,
} from "@omni-agent/core";
import { runHostProcess } from "../process/host-process-runner";

export async function invokeToolImplementation(
  tool: AgentToolDefinition,
  input: Record<string, unknown>,
  context: ToolExecutionContext = { cwd: process.cwd() },
) {
  const binder = tool.access.kind === "dynamic" ? tool.access.bindInput : undefined;
  const executionInput = binder
    ? await binder(structuredClone(input), {
        cwd: context.cwd,
        agentId: "test",
        toolCallId: "test-call",
        workspaceId: "test-workspace",
        workspaceRoot: context.cwd,
        hostRuntime: { platform: process.platform, home: process.env.HOME ?? context.cwd },
        signal: context.signal,
      })
    : input;
  if (isInProcessTool(tool)) return tool.execute(executionInput, context);
  if (!isProcessTool(tool)) throw new Error("Unsupported tool execution strategy");
  const invocation = await tool.createProcessInvocation(executionInput, context);
  const result = await runHostProcess({ ...invocation, signal: context.signal });
  return tool.createToolResult(result, executionInput, context);
}

export function invokeUnboundToolImplementation(
  tool: AgentToolDefinition,
  input: Record<string, unknown>,
  context: ToolExecutionContext = { cwd: process.cwd() },
) {
  if (!isInProcessTool(tool)) throw new Error("Expected an in-process tool");
  return tool.execute(input, context);
}
