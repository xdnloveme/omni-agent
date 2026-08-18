/**
 * Stream event types for the agent streaming engine.
 *
 * These events are designed to be independent of any rendering layer,
 * enabling harness replay/record, TUI rendering, JSON-line output, or test mocks.
 */

import type { ExtensionEvent } from "../extension-events";
import type {
  AgentFailure,
  TokenUsage,
  ToolBatchDescriptor,
  ToolBatchPosition,
  ToolInvocationPreview,
} from "../types";
import type { ContextProgressEvent, ModelContextSnapshotManifest } from "../context";
import type { ModelCacheReport } from "../models/cache";

/** Text chunk streamed from the LLM */
export interface TextDeltaEvent {
  type: "text_delta";
  modelCallId: string;
  textSegmentId: string;
  delta: string;
}

export interface FinalResponseEvent {
  type: "final_response";
  modelCallId: string;
}

export interface ThinkingStartedEvent {
  type: "thinking_start";
  modelCallId: string;
  contentIndex: number;
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  modelCallId: string;
  contentIndex: number;
  delta: string;
}

export interface ThinkingCompletedEvent {
  type: "thinking_end";
  modelCallId: string;
  contentIndex: number;
  content: string;
}

/** A tool invocation has started */
export interface ToolBatchStartedEvent {
  type: "tool_batch_started";
  batch: ToolBatchDescriptor;
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  preview: ToolInvocationPreview;
  batch: ToolBatchPosition;
}

/** A tool invocation has completed */
export interface ToolUseEndEvent {
  type: "tool_use_end";
  toolName: string;
  toolCallId: string;
  result: ToolResultPayload;
  durationMs: number;
  batch: ToolBatchPosition;
}

export interface ToolBatchCompletedEvent {
  type: "tool_batch_completed";
  batchId: string;
  modelCallId: string;
  durationMs: number;
}

/** Stream completed successfully */
export interface DoneEvent {
  type: "done";
  usage?: TokenUsage;
}

export interface ModelContextPreparedEvent {
  type: "model_context_prepared";
  manifest: ModelContextSnapshotManifest;
}

export interface ModelCacheReportEvent {
  type: "model_cache_report";
  report: ModelCacheReport;
}

export interface ContextProgressStreamEvent {
  type: "context_progress";
  event: ContextProgressEvent;
}

/** Stream encountered an error */
export interface ErrorEvent {
  type: "error";
  failure: AgentFailure;
}

/** Union of all stream events */
export type StreamEvent =
  | TextDeltaEvent
  | FinalResponseEvent
  | ThinkingStartedEvent
  | ThinkingDeltaEvent
  | ThinkingCompletedEvent
  | ModelContextPreparedEvent
  | ModelCacheReportEvent
  | ContextProgressStreamEvent
  | ToolBatchStartedEvent
  | ToolUseStartEvent
  | ToolUseEndEvent
  | ToolBatchCompletedEvent
  | ExtensionEvent
  | DoneEvent
  | ErrorEvent;

/** Tool result payload (mirrors core ToolResult but decoupled) */
export interface ToolResultPayload {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  meta?: import("../types").ToolResultMetadata;
}

/**
 * Callbacks interface for stream consumers.
 *
 * TUI is one implementation; harness (JSON-line, test mock, etc.) is another.
 * All callbacks are optional — consumers only subscribe to what they need.
 */
export interface StreamCallbacks {
  onTextChunk?: (event: TextDeltaEvent) => void;
  onFinalResponse?: (event: FinalResponseEvent) => void;
  onThinkingStart?: (event: ThinkingStartedEvent) => void;
  onThinkingChunk?: (event: ThinkingDeltaEvent) => void;
  onThinkingEnd?: (event: ThinkingCompletedEvent) => void;
  onModelContextPrepared?: (manifest: ModelContextSnapshotManifest) => void;
  onModelCacheReport?: (report: ModelCacheReport) => void;
  onContextProgress?: (event: ContextProgressEvent) => void;
  onToolBatchStart?: (event: ToolBatchStartedEvent) => void;
  onToolStart?: (event: ToolUseStartEvent) => void;
  onToolEnd?: (event: ToolUseEndEvent) => void;
  onToolBatchEnd?: (event: ToolBatchCompletedEvent) => void;
  onExtensionEvent?: (event: ExtensionEvent) => void;
  onDone?: (usage?: TokenUsage) => void;
  onError?: (failure: AgentFailure) => void;
}

/** State of the stream session state machine */
export type StreamState = "idle" | "streaming" | "done" | "error";

/** Accumulated message entry for replay/inspection */
export interface AccumulatedMessage {
  type: "text" | "thinking" | "tool_call" | "tool_result";
  content: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}
