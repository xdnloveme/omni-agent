import type { ModelCacheCapability } from "@omni-agent/core";

export const providerContributionBrand: unique symbol = Symbol("ProviderContribution");

/** Opaque provider contribution passed between vendor plugins and the models runtime. */
export interface ProviderContribution {
  readonly id: string;
  readonly credentialAliases: readonly string[];
  readonly cacheCapability?: ModelCacheCapability;
  readonly [providerContributionBrand]: true;
}
