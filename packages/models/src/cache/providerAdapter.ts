import type { ModelCacheCapability, ModelCacheDirective } from "@omni-agent/core";
import type { ProviderCacheOptions } from "./contracts";

export function toProviderCacheOptions(
  directive: ModelCacheDirective,
  capability: ModelCacheCapability,
): ProviderCacheOptions {
  // Disabling cache must also suppress Provider affinity/cache-key metadata.
  return {
    ...(capability.stableScopeRetentions.includes(directive.retention)
      ? { sessionId: directive.scopeId }
      : {}),
    cacheRetention: directive.retention,
  };
}
