import type { PreparedModelContext } from "../../context";
import type { EnvironmentContextRecord } from "../../environment";
import type { AssistantTranscriptMessage, TranscriptMessage } from "../../messages";
import type { AgentEvent, AgentFailure, TokenUsage } from "../../types";
import type { ToolLoopDiagnostic } from "../../loop-protection";
import type { StreamEvent } from "../../stream";

export type PublishAgentEvent = <T extends AgentEvent & StreamEvent>(
  event: T,
  sessionEvent?: StreamEvent,
) => T;

export interface PreparedModelInvocation {
  readonly context: PreparedModelContext;
  readonly environment: EnvironmentContextRecord;
  readonly sessionId: string;
  readonly promptLeaseId: string | undefined;
}

export type EnvironmentPhaseResult =
  | { readonly kind: "captured" }
  | {
      readonly kind: "failed";
      readonly event: Extract<AgentEvent, { type: "error" }>;
    };

export type ModelPhaseResult =
  | {
      readonly kind: "response";
      readonly response: AssistantTranscriptMessage;
      readonly usage: TokenUsage;
      readonly modelCallId: string;
    }
  | {
      readonly kind: "failed";
      readonly event: Extract<AgentEvent, { type: "error" }>;
    };

export type ToolBatchPhaseResult =
  | {
      readonly kind: "continue";
      readonly messages: readonly TranscriptMessage[];
    }
  | {
      readonly kind: "halt";
      readonly messages: readonly TranscriptMessage[];
      readonly failure: AgentFailure;
      readonly diagnostic: ToolLoopDiagnostic;
    };

export type LoopIterationResult =
  | { readonly kind: "continue"; readonly usage?: TokenUsage }
  | { readonly kind: "completed"; readonly usage?: TokenUsage }
  | { readonly kind: "failed"; readonly usage?: TokenUsage }
  | { readonly kind: "max_turns"; readonly maxTurns: number; readonly usage?: TokenUsage };
