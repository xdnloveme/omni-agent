import type { DeepReadonly, JsonValue } from "../../data";
import type {
  AssistantTranscriptMessage,
  ModelContextMessage,
  ToolResultTranscriptMessage,
  TranscriptMessage,
} from "../../messages";
import type { ModelToolSpec } from "../../models/runtime";

export interface ContextConversationSource {
  readonly messages: readonly TranscriptMessage[];
}

export interface ContextArtifactRecoveryCapability {
  readonly toolName: string;
  readonly instruction: string;
}

export interface ContextModelLimits {
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export interface ContextDraft {
  readonly systemPrompt: string;
  readonly messages: readonly TranscriptMessage[];
  readonly tools: readonly ModelToolSpec[];
  readonly model: ContextModelLimits;
}

export interface ContextMiddlewareOptions {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly signal?: AbortSignal;
}

export interface ContextPolicyStageOptions {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly estimate: ContextTokenEstimate;
  readonly signal?: AbortSignal;
}

export interface ContextRewriteGuardInput {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly estimate: ContextTokenEstimate;
  readonly signal?: AbortSignal;
}

export type ContextRewriteGuardDecision =
  | { readonly action: "allow"; readonly reason: string }
  | {
      readonly action: "defer";
      readonly reason: string;
      readonly reconsiderAt?: number;
    };

export interface ContextFinalGateOptions extends ContextPolicyStageOptions {
  readonly sessionRevision: number;
  readonly middlewareDigest: string;
  readonly sourceMessages: readonly TranscriptMessage[];
  readonly precedingStages: readonly ContextComponentManifest[];
}

export interface ContextPolicyResolveOptions {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly sessionRevision: number;
  readonly middlewareDigest: string;
  readonly sourceMessages: readonly TranscriptMessage[];
  readonly signal?: AbortSignal;
}

export interface ContextDecision {
  readonly type: string;
  readonly details?: DeepReadonly<Record<string, JsonValue>>;
}

export interface TranscriptContextEntry {
  readonly kind: "transcript";
  readonly sourceIndex: number;
  readonly message: TranscriptMessage;
}

export interface CheckpointContextEntry {
  readonly kind: "checkpoint";
  readonly checkpointId: string;
  readonly parentId?: string;
  readonly coveredMessageCount: number;
  readonly promptVersion: number;
  readonly summary: string;
  readonly summaryModelCallId: string;
}

export interface ToolResultArtifactEntry {
  readonly kind: "toolResultArtifact";
  readonly sourceIndex: number;
  readonly message: ToolResultTranscriptMessage;
  readonly artifact: {
    readonly id: string;
    readonly path: string;
    readonly contentDigest: string;
    readonly originalLength: number;
    readonly recoveryInstruction: string;
  };
}

export type ContextEntry =
  TranscriptContextEntry | CheckpointContextEntry | ToolResultArtifactEntry;

export interface ContextFrame {
  readonly entries: readonly ContextEntry[];
  readonly systemPrompt: string;
  readonly tools: readonly ModelToolSpec[];
  readonly model: ContextModelLimits;
}

export interface ContextTokenEstimate {
  readonly systemPromptTokens: number;
  readonly messageTokens: number;
  readonly toolTokens: number;
  readonly totalInputTokens: number;
  readonly usableInputBudget: number;
  readonly usageRatio: number;
}

export interface ContextPolicyStageResult {
  readonly frame: ContextFrame;
  readonly decisions: readonly ContextDecision[];
}

export interface ContextPolicyStageManifest extends ContextComponentManifest {
  readonly before: ContextTokenEstimate;
  readonly after: ContextTokenEstimate;
}

export interface ContextPolicyResult {
  readonly frame: ContextFrame;
  readonly decisions: readonly ContextDecision[];
  readonly stages: readonly ContextPolicyStageManifest[];
  readonly estimate: ContextTokenEstimate;
}

export interface ContextComponentManifest {
  readonly name: string;
  readonly version: number;
  readonly configurationDigest?: string;
}

export interface ModelContextSnapshotManifest {
  readonly snapshotId: string;
  readonly modelCallId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly policyStages: readonly ContextPolicyStageManifest[];
  readonly middleware: readonly ContextComponentManifest[];
  readonly sourceMessageCount: number;
  readonly outputMessageCount: number;
  readonly sourceDigest: string;
  readonly contextEntryDigest: string;
  readonly outputDigest: string;
  readonly systemPromptDigest: string;
  readonly toolsetDigest: string;
  readonly estimatedInputTokens: number;
  readonly usableInputBudget: number;
  readonly usageRatio: number;
  readonly artifactIds: readonly string[];
  readonly checkpoint?: {
    readonly action: "reuse" | "create" | "extend";
    readonly checkpointId: string;
    readonly parentId?: string;
    readonly coveredMessageCount: number;
    readonly summaryDigest: string;
    readonly summaryModelCallId: string;
  };
  readonly decisions: readonly ContextDecision[];
  readonly createdAt: number;
}

export interface PreparedModelContext {
  readonly snapshotId: string;
  readonly systemPrompt: string;
  readonly messages: readonly ModelContextMessage[];
  readonly tools: readonly ModelToolSpec[];
  readonly manifest: ModelContextSnapshotManifest;
}

export interface ModelCallCompletedContext {
  readonly request: PreparedModelContext;
  readonly response: AssistantTranscriptMessage;
}
