import type { DeepReadonly } from "../data";
import type { ModelCallIdentity } from "./call";
import type { RuntimeModelSelection } from "./runtime";

export type ModelCacheRetention = "none" | "short" | "long";

export type ModelCacheMode = "none" | "automatic_prefix" | "explicit_breakpoint";

export interface ModelCacheIntent {
  readonly retention: "default" | ModelCacheRetention;
}

export interface ModelCacheDirective {
  readonly scopeId: string;
  readonly retention: ModelCacheRetention;
}

export interface ModelCacheCapability {
  readonly mode: ModelCacheMode;
  readonly retentions: readonly ModelCacheRetention[];
  readonly stableScopeRetentions: readonly ModelCacheRetention[];
  readonly shortTtlMs?: number;
  readonly longTtlMs?: number;
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
  readonly inputTokens: number;
  readonly cacheHitRate?: number;
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

export type ModelCacheLeaseStatus = "disabled" | "cold" | "active" | "expired" | "unknown_expiry";

export interface ModelCacheLeaseAdvice {
  readonly status: ModelCacheLeaseStatus;
  readonly scopeId: string;
  readonly retention: ModelCacheRetention;
  readonly expiresAt?: number;
}

export interface ModelCacheLeaseAdvisorPort {
  inspect(
    selection: RuntimeModelSelection,
    identity: ModelCallIdentity,
    intent: ModelCacheIntent,
  ): ModelCacheLeaseAdvice;
}
