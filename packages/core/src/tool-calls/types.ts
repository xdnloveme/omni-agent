import type { ToolExecutionMiddleware } from "../middleware";
import type { ToolLifecycleAdapter } from "../tool-lifecycle";
import type { AgentEvent } from "../types";

export interface ToolCallRequest {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ToolCallEnvironment {
  agentId: string;
  cwd: string;
  middleware: readonly ToolExecutionMiddleware[];
  lifecycleAdapters: readonly ToolLifecycleAdapter[];
}

export interface ToolCallMetrics {
  authorizationMs: number;
  executionMs: number;
  totalMs: number;
}

export type ToolCallEvent = Extract<
  AgentEvent,
  { type: "tool_start" | "tool_end" | "extension_event" }
>;
