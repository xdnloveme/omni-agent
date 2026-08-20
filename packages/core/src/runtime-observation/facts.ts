import type { PreparedModelContext, ContextProgressEvent } from "../context";
import type { RuntimeModelSelection } from "../models";
import type { ModelCacheReport } from "../models/cache";
import type { AssistantTranscriptMessage } from "../messages";
import type { AgentFailure, TokenUsage, ToolBatchDescriptor, ToolResult } from "../types";
import type { ToolCallMetrics, ValidatedToolResult } from "../tool-calls/types";

export interface RuntimeRunStartedFact {
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
}

export interface RuntimeUserInputFact {
  readonly input: string;
}

export interface RuntimeOperationStartedFact {
  readonly kind: "environment_capture" | "session_append_input" | "session_persist_output";
  readonly turn?: number;
}

export interface RuntimeOperationCompletedFact {}

export interface RuntimeFailedFact {
  readonly error: unknown;
}

export interface RuntimeCancelledFact {
  readonly error?: unknown;
}

export interface RuntimeRunCompletedFact {
  readonly usage?: TokenUsage;
  readonly failure?: AgentFailure;
}

export interface RuntimeRunFailedFact {
  readonly error: unknown;
  readonly failure: AgentFailure;
}

export interface RuntimeRunCancelledFact {
  readonly error: unknown;
  readonly failure: AgentFailure;
}

export interface RuntimeTurnStartedFact {
  readonly turn: number;
}

export interface RuntimeTurnCompletedFact {
  readonly turn: number;
  readonly usage?: TokenUsage;
}

export interface RuntimeFinalResponseFact {
  readonly modelCallId: string;
}

export interface RuntimeTurnFailedFact {
  readonly turn: number;
  readonly failure: AgentFailure;
}

export interface RuntimeContextStartedFact {
  readonly turn: number;
}

export interface RuntimeContextProgressFact {
  readonly turn: number;
  readonly event: ContextProgressEvent;
}

export interface RuntimeContextPreparedFact {
  readonly turn: number;
  readonly context: PreparedModelContext;
}

export interface RuntimeModelCallStartedFact {
  readonly turn: number;
  readonly modelCallId: string;
  readonly modelId: string;
  readonly estimatedInputTokens: number;
}

export interface RuntimeModelRequestCapturedFact {
  readonly context: PreparedModelContext;
  readonly selection: RuntimeModelSelection;
}

export type RuntimeModelOutputFact =
  | {
      readonly kind: "text_delta";
      readonly modelCallId: string;
      readonly textSegmentId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "thinking_started";
      readonly modelCallId: string;
      readonly contentIndex: number;
    }
  | {
      readonly kind: "thinking_delta";
      readonly modelCallId: string;
      readonly contentIndex: number;
      readonly delta: string;
    }
  | {
      readonly kind: "thinking_completed";
      readonly modelCallId: string;
      readonly contentIndex: number;
      readonly content: string;
    }
  | {
      readonly kind: "cache_reported";
      readonly report: ModelCacheReport;
    };

export interface RuntimeModelCallCompletedFact {
  readonly response: AssistantTranscriptMessage;
  readonly usage: TokenUsage;
  readonly timeToFirstEventMs?: number;
}

export interface RuntimeModelCallFailedFact {
  readonly failure: AgentFailure;
  readonly error?: unknown;
}

export interface RuntimeToolBatchStartedFact {
  readonly batch: ToolBatchDescriptor;
}

export interface RuntimeToolBatchCompletedFact {
  readonly batchId: string;
  readonly modelCallId: string;
  readonly durationMs: number;
}

export interface RuntimeToolCallStartedFact {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly batchId?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly hiddenInputKeys?: readonly string[];
}

export interface RuntimeToolCallResultFact {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly batchId?: string;
  readonly result: ValidatedToolResult;
  readonly metrics: ToolCallMetrics;
}

export interface RuntimeToolCallCompletedFact {
  readonly result: ToolResult;
}

export interface RuntimeToolCallDeniedFact {
  readonly result: ToolResult;
}

export interface RuntimePreflightStartedFact {
  readonly toolName: string;
  readonly toolCallId: string;
}

export interface RuntimePreflightCompletedFact {
  readonly outcome: "ready" | "error";
}

export interface RuntimeAuthorizationStartedFact {
  readonly toolName: string;
  readonly toolCallId: string;
}

export interface RuntimeAuthorizationCompletedFact {
  readonly outcome: "allowed";
  readonly authorizationMs: number;
}

export interface RuntimeAuthorizationDeniedFact {
  readonly authorizationMs: number;
}

export interface RuntimeExecutionStartedFact {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly batchId?: string;
}

export interface RuntimeExecutionCompletedFact {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly batchId?: string;
  readonly result: ToolResult;
  readonly executionMs: number;
}

export interface RuntimeExecutionTimedOutFact extends RuntimeExecutionCompletedFact {
  readonly error: unknown;
}
