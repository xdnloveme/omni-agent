export type ContextCompressionKind =
  "artifact_projection" | "skill_projection" | "thinking_projection" | "heavy_checkpoint";

export interface ContextCompressionOperationSummary {
  readonly kind: ContextCompressionKind;
  readonly affectedCount: number;
  readonly action?: "create" | "extend";
}

export interface ContextCompressionTrigger {
  readonly inputTokens: number;
  readonly usableInputBudget: number;
  readonly thresholdTokens: number;
}

export interface ContextCompressionReport {
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly tokenDelta: number;
  readonly reductionRatio: number;
  readonly trigger: ContextCompressionTrigger;
  readonly operations: readonly ContextCompressionOperationSummary[];
  readonly durationMs: number;
}

export type ContextProgressEvent =
  | {
      readonly type: "compression_started";
      readonly compressionId: string;
      readonly modelCallId: string;
      readonly beforeTokens: number;
      readonly startedKind: ContextCompressionKind;
      readonly trigger: ContextCompressionTrigger;
    }
  | {
      readonly type: "compression_completed";
      readonly compressionId: string;
      readonly modelCallId: string;
      readonly report: ContextCompressionReport;
    }
  | {
      readonly type: "compression_failed";
      readonly compressionId: string;
      readonly modelCallId: string;
      readonly reason: string;
      readonly cancelled: boolean;
    };

export interface ContextProgressSinkPort {
  publish(event: ContextProgressEvent): void;
}

export interface ContextCompressionReporterPort {
  begin(kind: ContextCompressionKind, trigger: ContextCompressionTrigger): void;
  record(operation: ContextCompressionOperationSummary): void;
}
