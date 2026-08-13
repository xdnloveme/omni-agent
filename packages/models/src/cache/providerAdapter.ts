import type { ModelCacheCapability, ModelCacheDirective } from "@omni-agent/core";
import type { ProviderCacheOptions } from "./contracts";

export function toProviderCacheOptions(
  directive: ModelCacheDirective,
  capability: ModelCacheCapability,
): ProviderCacheOptions {
  // Disabling cache must also suppress Provider affinity/cache-key metadata.
  return {
    ...(capability.supportsStableScopeKey && directive.retention !== "none"
      ? { sessionId: directive.scopeId }
      : {}),
    cacheRetention: directive.retention,
  };
}
