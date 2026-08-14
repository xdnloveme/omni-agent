import type {
  ModelCacheRetention,
  ModelEvent,
  ModelRequest,
  RuntimeModelSelection,
} from "@omni-agent/core";

export interface ModelCacheFingerprint {
  readonly staticPrefixDigest: string;
  readonly messageDigests: readonly string[];
  readonly requestSemanticsDigest: string;
}

export interface ProviderCacheOptions {
  readonly sessionId?: string;
  readonly cacheRetention: ModelCacheRetention;
}

export type ModelTransportEvent = Exclude<ModelEvent, { type: "cache_report" }>;

export interface ModelTransportExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxOutputTokens: number;
  readonly credential?: { readonly type: "api_key"; readonly key: string };
  readonly providerCache: ProviderCacheOptions;
}

export interface ModelTransportRuntimePort {
  stream(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    options: ModelTransportExecutionOptions,
  ): AsyncIterable<ModelTransportEvent>;
}
