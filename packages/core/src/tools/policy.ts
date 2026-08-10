import type { AgentTool } from "../types";

export interface ToolPolicyContext {
  tool: AgentTool;
  input: Record<string, unknown>;
}

export type ToolPolicyDecision = { allowed: true } | { allowed: false; reason: string };

export interface ToolPolicy {
  evaluate(context: ToolPolicyContext): ToolPolicyDecision | Promise<ToolPolicyDecision>;
}
