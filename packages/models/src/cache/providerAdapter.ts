import type {
  ModelCacheCapability,
  ModelCacheDirective,
  ModelCacheRetention,
} from "@omni-agent/core";

export interface ProviderCacheOptions {
  readonly sessionId?: string;
  readonly cacheRetention: ModelCacheRetention;
}

export function toProviderCacheOptions(
  directive: ModelCacheDirective,
  capability: ModelCacheCapability,
): ProviderCacheOptions {
  return {
    ...(capability.supportsStableScopeKey && directive.retention !== "none"
      ? { sessionId: directive.scopeId }
      : {}),
    cacheRetention: directive.retention,
  };
}
