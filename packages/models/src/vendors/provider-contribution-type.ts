export const providerContributionBrand: unique symbol = Symbol("ProviderContribution");

/** Opaque provider contribution passed between vendor plugins and the models runtime. */
export interface ProviderContribution {
  readonly id: string;
  readonly credentialAliases: readonly string[];
  readonly [providerContributionBrand]: true;
}
