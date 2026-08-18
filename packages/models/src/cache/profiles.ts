import type { ModelCacheCapability } from "@omni-agent/core";

export const noCache: ModelCacheCapability = {
  mode: "none",
  retentions: ["none"],
  stableScopeRetentions: [],
};

export const automaticShortCache: ModelCacheCapability = {
  mode: "automatic_prefix",
  retentions: ["none", "short"],
  stableScopeRetentions: [],
};

export const stableAutomaticShortCache: ModelCacheCapability = {
  ...automaticShortCache,
  stableScopeRetentions: ["short"],
};
