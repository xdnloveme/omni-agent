import type { DeepReadonly, JsonValue } from "../../data";
import type {
  AssistantTranscriptMessage,
  ModelContextMessage,
  TranscriptMessage,
} from "../../messages";
import type { ModelToolSpec } from "../../models/runtime";

export interface ContextConversationSource {
  readonly messages: readonly TranscriptMessage[];
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

export interface ContextStrategyOptions {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly signal?: AbortSignal;
}

export interface ContextDecision {
  readonly type: string;
  readonly details?: DeepReadonly<Record<string, JsonValue>>;
}

export interface ContextStrategyResult {
  readonly messages: readonly TranscriptMessage[];
  readonly decisions: readonly ContextDecision[];
}

export interface ContextComponentManifest {
  readonly name: string;
  readonly version: number;
}

export interface ModelContextSnapshotManifest {
  readonly snapshotId: string;
  readonly modelCallId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly strategy: ContextComponentManifest;
  readonly middleware: readonly ContextComponentManifest[];
  readonly sourceMessageCount: number;
  readonly outputMessageCount: number;
  readonly sourceDigest: string;
  readonly outputDigest: string;
  readonly systemPromptDigest: string;
  readonly toolsetDigest: string;
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
