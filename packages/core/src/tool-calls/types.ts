import type { ToolExecutionMiddleware } from "../middleware";
import type { ToolLifecycleAdapter } from "../tool-lifecycle";
import type { JsonValue } from "../data";
import type { ToolResult } from "../types";
import type { RegisteredAgentTool } from "../types";
import type { ToolAccessIntent } from "../access";
import type { RuntimeToolBatchObservation } from "../runtime-observation";

export interface ToolCallRequest {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ToolCallEnvironment {
  agentId: string;
  workspaceId: string;
  workspaceRoot: string;
  batchId?: string;
  cwd: string;
  middleware: readonly ToolExecutionMiddleware[];
  lifecycleAdapters: readonly ToolLifecycleAdapter[];
  origin?: "agent" | "hook";
  onPermissionResolved?: (event: {
    readonly permissionId: string;
    readonly decision: "approve" | "deny";
    readonly reason: string;
  }) => void | Promise<void>;
}

declare const preparedToolCallBrand: unique symbol;

export interface PreparedToolCall {
  readonly [preparedToolCallBrand]: true;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly tool?: RegisteredAgentTool;
  readonly accessIntent?: ToolAccessIntent;
  readonly preparation: "ready" | "failed";
  readonly failure?: ValidatedToolResult;
}

export interface PreparedToolBatch {
  readonly calls: readonly PreparedToolCall[];
}

export interface ToolBatchPreparationRequest {
  readonly tools: readonly RegisteredAgentTool[];
  readonly calls: readonly ToolCallRequest[];
  readonly environment: ToolCallEnvironment;
  readonly observation?: RuntimeToolBatchObservation;
}

export interface PreparedToolExecutionContext {
  readonly environment: ToolCallEnvironment;
  readonly observation?: RuntimeToolBatchObservation;
  /** Rechecks mutable preparation facts after consent, before planning or execution. */
  readonly revalidate?: () => Promise<ToolResult | undefined>;
}

export type ToolBatchPreparationDecision =
  | { readonly kind: "executable" }
  | {
      readonly kind: "deferred";
      readonly code: string;
      readonly message: string;
      readonly promptSections?: readonly import("../system-prompt").RuntimePromptSection[];
    }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

export interface ToolBatchPreparationPolicy {
  beginRun?(): void | Promise<void>;
  /** Compaction can remove facts previously delivered through deferred ToolResults. */
  onContextCheckpoint?(checkpointId: string): void | Promise<void>;
  evaluate(
    batch: PreparedToolBatch,
    context: ToolBatchPreparationContext,
  ): Promise<ToolBatchPreparationDecision>;
}

export interface ToolBatchPreparationContext {
  readonly origin: "agent" | "hook";
}

export interface ToolCallMetrics {
  executed: boolean;
  accessMs: number;
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
