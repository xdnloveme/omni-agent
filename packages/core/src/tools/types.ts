import type { AgentTool, ToolResult } from "../types";

export type ToolRisk = "read" | "write" | "execute" | "network";
export type ToolApproval = "never" | "always" | "policy";

export interface ToolContext<T = unknown> {
  agentId?: string;
  sessionId?: string;
  cwd: string;
  signal?: AbortSignal;
  data?: T;
}

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
  risk?: ToolRisk;
  approval?: ToolApproval;
  timeoutMs?: number;
  isEnabled?: (context: ToolContext<T>) => boolean;
  execute(input: Record<string, unknown>, context: ToolContext<T>): Promise<ToolResult>;
}

export function toLegacyAgentTool<T>(
  tool: ToolDefinition<T>,
  context: Omit<ToolContext<T>, "signal">,
): AgentTool {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.inputSchema,
    strict: tool.strict,
    risk: tool.risk,
    approval: tool.approval,
    timeoutMs: tool.timeoutMs,
    execute: (input, signal) => tool.execute(input, { ...context, signal }),
  };
}
