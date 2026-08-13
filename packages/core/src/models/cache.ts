import type { DeepReadonly } from "../data";

export type ModelCacheRetention = "none" | "short" | "long";

export type ModelCacheMode = "none" | "automatic_prefix" | "explicit_breakpoint";

export interface ModelCallIdentity {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly contextSnapshotId?: string;
  readonly purpose: "primary" | "auxiliary";
}

export interface ModelCacheIntent {
  readonly retention: "default" | ModelCacheRetention;
}

export interface ModelCacheDirective {
  readonly scopeId: string;
  readonly retention: ModelCacheRetention;
  readonly semanticsVersion: number;
}

export interface ModelCacheCapability {
  readonly mode: ModelCacheMode;
  readonly retentions: readonly ModelCacheRetention[];
  readonly supportsStableScopeKey: boolean;
  readonly shortTtlMs?: number;
  readonly longTtlMs?: number;
}

export interface ModelCacheFingerprint {
  readonly staticPrefixDigest: string;
  readonly messageDigests: readonly string[];
  readonly requestSemanticsDigest: string;
  readonly requestDigest: string;
}

export type ModelCacheLifecycle =
  | "cold"
  | "append_only"
  | "tail_changed"
  | "prefix_rewritten"
  | "rebased"
  | "expired"
  | "incompatible";

export interface ModelCacheReport {
  readonly outcome: "success" | "failed" | "cancelled";
  readonly modelCallId: string;
  readonly contextSnapshotId?: string;
  readonly scopeId: string;
  readonly requestedRetention: ModelCacheIntent["retention"];
  readonly appliedRetention: ModelCacheRetention;
  readonly capability: ModelCacheCapability;
  readonly lifecycle: ModelCacheLifecycle;
  readonly commonPrefixMessageCount: number;
  readonly previousMessageCount: number;
  readonly currentMessageCount: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reason?: string;
  readonly createdAt: number;
}

export interface ModelCachePolicyInput {
  readonly identity: ModelCallIdentity;
  readonly intent: ModelCacheIntent;
  readonly capability: ModelCacheCapability;
  readonly selection: {
    readonly providerId: string;
    readonly modelId: string;
    readonly requestModelId?: string;
  };
}

export interface ModelCachePolicyDecision {
  readonly directive: ModelCacheDirective;
  readonly reason?: string;
}

export interface ModelCachePolicyPort {
  resolve(input: DeepReadonly<ModelCachePolicyInput>): ModelCachePolicyDecision;
}
