import type { ToolCallContent } from "../models/messages";
import type { ToolResult } from "../types";

export type LoopDecisionSource =
  "repeated_result" | "repeated_error" | "repeated_batch" | "alternating_batch";

export type LoopDecision =
  | { type: "continue" }
  | {
      type: "warn";
      severity: "soft" | "strong";
      source: LoopDecisionSource;
      count: number;
      signature: string;
      toolNames: string[];
      period?: 1 | 2;
    }
  | {
      type: "halt";
      source: Exclude<LoopDecisionSource, "repeated_error">;
      count: number;
      signature: string;
      toolNames: string[];
      period?: 1 | 2;
    };

export interface ToolLoopDiagnostic {
  kind: "repeated_result" | "repeated_batch" | "alternating_batch";
  count: number;
  signature: string;
  toolNames: string[];
  period?: 1 | 2;
}

export type LoopBatchDecision =
  | { type: "continue" }
  | { type: "warn" }
  | { type: "halt"; error: string; diagnostic: ToolLoopDiagnostic };

export interface BatchCycleEvaluation {
  decision: LoopDecision;
  activeCycle?: {
    kind: "alternating_batch";
    phase: "partial" | "complete";
    completedCycles: number;
  };
}

export interface ToolResultObservation {
  call: ToolCallContent;
  toolIdentity?: string;
  result: ToolResult;
}
