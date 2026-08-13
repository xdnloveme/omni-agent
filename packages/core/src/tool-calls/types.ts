import type { ToolExecutionMiddleware } from "../middleware";
import type { ToolLifecycleAdapter } from "../tool-lifecycle";
import type { AgentEvent } from "../types";
import type { JsonValue } from "../data";
import type { ToolResult } from "../types";

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

export interface ValidatedToolResult extends Omit<ToolResult, "meta"> {
  readonly meta?: Record<string, JsonValue>;
}

type BaseToolCallEvent = Extract<
  AgentEvent,
  { type: "tool_start" | "tool_end" | "extension_event" }
>;

export type ToolCallEvent =
  | Exclude<BaseToolCallEvent, { type: "tool_end" }>
  | (Omit<Extract<BaseToolCallEvent, { type: "tool_end" }>, "result"> & {
      readonly result: ValidatedToolResult;
    });
