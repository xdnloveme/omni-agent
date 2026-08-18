import type { ModelCacheCapability } from "@omni-agent/core";

export interface ProviderCacheModel {
  readonly id: string;
  readonly compat?: unknown;
}

export type ProviderCacheCapabilityDeclaration =
  ModelCacheCapability | ((model: ProviderCacheModel) => ModelCacheCapability);

export const providerContributionBrand: unique symbol = Symbol("ProviderContribution");

/** Opaque provider contribution passed between vendor plugins and the models runtime. */
export interface ProviderContribution {
  readonly id: string;
  readonly credentialAliases: readonly string[];
  readonly resolveCacheCapability?: (model: ProviderCacheModel) => ModelCacheCapability;
  readonly [providerContributionBrand]: true;
}
