/**
 * Stream event types for the agent streaming engine.
 *
 * These events are designed to be independent of any rendering layer,
 * enabling harness replay/record, TUI rendering, JSON-line output, or test mocks.
 */

import type { ExtensionEvent } from "../extension-events";
import type { TokenUsage } from "../types";

/** Text chunk streamed from the LLM */
export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

/** A tool invocation has started */
export interface ToolUseStartEvent {
  type: "tool_use_start";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** A tool invocation has completed */
export interface ToolUseEndEvent {
  type: "tool_use_end";
  toolName: string;
  toolCallId: string;
  result: ToolResultPayload;
  durationMs: number;
}

/** Stream completed successfully */
export interface DoneEvent {
  type: "done";
  usage?: TokenUsage;
}

/** Stream encountered an error */
export interface ErrorEvent {
  type: "error";
  error: string;
}

/** Union of all stream events */
export type StreamEvent =
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseEndEvent
  | ExtensionEvent
  | DoneEvent
  | ErrorEvent;

/** Tool result payload (mirrors core ToolResult but decoupled) */
export interface ToolResultPayload {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Callbacks interface for stream consumers.
 *
 * TUI is one implementation; harness (JSON-line, test mock, etc.) is another.
 * All callbacks are optional — consumers only subscribe to what they need.
 */
export interface StreamCallbacks {
  onTextChunk?: (delta: string) => void;
  onToolStart?: (toolName: string, toolCallId: string, input: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string, toolCallId: string, result: ToolResultPayload, durationMs: number) => void;
  onExtensionEvent?: (event: ExtensionEvent) => void;
  onDone?: (usage?: TokenUsage) => void;
  onError?: (error: string) => void;
}

/** State of the stream session state machine */
export type StreamState = "idle" | "streaming" | "done" | "error";

/** Accumulated message entry for replay/inspection */
export interface AccumulatedMessage {
  type: "text" | "tool_call" | "tool_result";
  content: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}
