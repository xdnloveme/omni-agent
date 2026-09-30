import type { DeepReadonly } from "../../data";
import type { ModelToolSpec } from "../../models/runtime";
import type {
  ContextArtifactRecoveryCapability,
  ContextConversationSource,
  ContextDraft,
  ContextEnvelope,
  ContextMiddlewareOptions,
  ContextModelLimits,
  ContextHistoryFrame,
  ContextEntry,
  ContextFinalGateOptions,
  ContextPolicyResult,
  ContextPolicyResolveOptions,
  ContextPolicyStageOptions,
  ContextPolicyStageResult,
  ContextRewriteGuardDecision,
  ContextRewriteGuardInput,
  ContextTokenEstimate,
  PreparedModelContext,
} from "./types";
import type { ContextProgressSinkPort } from "./progress";

export interface ContextMiddlewarePort {
  readonly name: string;
  readonly version: number;
  transform(
    draft: DeepReadonly<ContextDraft>,
    options: ContextMiddlewareOptions,
  ): ContextDraft | Promise<ContextDraft>;
}

export interface ContextPolicyStagePort {
  readonly name: string;
  readonly version: number;
  configurationDigest?(): string;
  apply(
    frame: DeepReadonly<ContextHistoryFrame>,
    options: DeepReadonly<ContextPolicyStageOptions>,
  ): Promise<ContextPolicyStageResult>;
}

export interface ContextRewriteGuardPort {
  assess(
    input: DeepReadonly<ContextRewriteGuardInput>,
  ): ContextRewriteGuardDecision | Promise<ContextRewriteGuardDecision>;
}

export interface ContextFinalGatePort {
  readonly name: string;
  readonly version: number;
  configurationDigest?(): string;
  apply(
    frame: DeepReadonly<ContextHistoryFrame>,
    options: DeepReadonly<ContextFinalGateOptions>,
  ): Promise<ContextPolicyStageResult>;
}

export interface ContextTokenEstimatorPort {
  estimate(envelope: DeepReadonly<ContextEnvelope>): ContextTokenEstimate;
  estimateEntry(entry: DeepReadonly<ContextEntry>): number;
}

export interface ContextPolicyPort {
  resolve(
    envelope: DeepReadonly<ContextEnvelope>,
    options: DeepReadonly<ContextPolicyResolveOptions>,
  ): Promise<ContextPolicyResult>;
}

export interface ContextPreparationRequest {
  readonly runDeadline?: import("../../execution/run-deadline").RunDeadlineSnapshot;
  readonly identity: {
    readonly agentId: string;
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly modelCallId: string;
  };
  readonly source: ContextConversationSource;
  readonly environment?: import("../../environment").EnvironmentContextRecord;
  readonly systemPrompt: string;
  readonly tools: readonly ModelToolSpec[];
  readonly model: ContextModelLimits;
  readonly middleware: readonly ContextMiddlewarePort[];
  readonly progress: ContextProgressSinkPort;
  readonly signal?: AbortSignal;
}

export interface ContextEnginePort {
  prepare(request: ContextPreparationRequest): Promise<PreparedModelContext>;
}

export interface ContextCapability {
  readonly policyStages?: readonly ContextPolicyStagePort[];
  readonly artifactRecovery?: ContextArtifactRecoveryCapability;
}
