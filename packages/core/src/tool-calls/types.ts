import type { ToolExecutionMiddleware } from "../middleware";
import type { ToolLifecycleAdapter } from "../tool-lifecycle";
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
  readonly transcriptDetails?: Record<string, JsonValue>;
}

export type ToolCallEvent =
  | {
      readonly type: "tool_start";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "tool_end";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly result: ValidatedToolResult;
      readonly durationMs: number;
      readonly metrics?: ToolCallMetrics;
    }
  | import("../extension-events").ExtensionEvent;
