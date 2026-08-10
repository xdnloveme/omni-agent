import type { AgentMessage } from "../models/messages";
import type { AgentConfig, ToolResult } from "../types";

export interface RunMiddleware {
  beforeModel?(config: AgentConfig, messages: readonly AgentMessage[]): void | Promise<void>;
  afterModel?(config: AgentConfig, messages: readonly AgentMessage[]): void | Promise<void>;
}

export interface ToolMiddleware {
  beforeTool?(toolName: string, input: Record<string, unknown>): void | Promise<void>;
  afterTool?(toolName: string, result: ToolResult): void | Promise<void>;
}

export type RuntimeMiddleware = RunMiddleware & ToolMiddleware;
