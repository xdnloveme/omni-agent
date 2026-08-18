import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import type { ModelCacheCapability } from "@omni-agent/core";
import type { ModelAuthMethod } from "../credentials/types";
import { normalizeModelCacheCapability } from "../cache/capability";
import {
  providerContributionBrand,
  type ProviderCacheCapabilityDeclaration,
  type ProviderCacheModel,
  type ProviderContribution,
} from "./provider-contribution-type";

const providers = new WeakMap<ProviderContribution, Provider>();

export function createProviderContribution(
  provider: Provider,
  credentialAliases: readonly string[] = [],
  cacheCapability?: ProviderCacheCapabilityDeclaration,
): ProviderContribution {
  if (!provider.id.trim()) throw new Error("Provider id is required");
  if (!provider.auth.apiKey && !provider.auth.oauth) {
    throw new Error(`Provider has no auth: ${provider.id}`);
  }
  const resolveCacheCapability = createCacheCapabilityResolver(cacheCapability);
  const contribution = {
    id: provider.id,
    credentialAliases: [...new Set(credentialAliases)],
    ...(resolveCacheCapability ? { resolveCacheCapability } : {}),
    [providerContributionBrand]: true as const,
  };
  providers.set(contribution, provider);
  return contribution;
}

function createCacheCapabilityResolver(
  declaration: ProviderCacheCapabilityDeclaration | undefined,
): ((model: ProviderCacheModel) => ModelCacheCapability) | undefined {
  if (!declaration) return undefined;
  if (typeof declaration === "function") {
    return (model) => normalizeModelCacheCapability(declaration(model));
  }
  const capability = normalizeModelCacheCapability(declaration);
  return () => capability;
}

function providerOf(contribution: ProviderContribution): Provider {
  const provider = providers.get(contribution);
  if (!provider) throw new Error(`Invalid provider contribution: ${contribution.id}`);
  return provider;
}

export function validateProviderContribution(contribution: ProviderContribution): void {
  providerOf(contribution);
}

export function installProvider(models: MutableModels, contribution: ProviderContribution): void {
  models.setProvider(providerOf(contribution));
}

export function getProviderAuthMethods(contribution: ProviderContribution): ModelAuthMethod[] {
  const auth = providerOf(contribution).auth;
  const methods: ModelAuthMethod[] = [];
  if (auth.apiKey)
    methods.push({
      type: "api_key",
      label: auth.apiKey.name,
      interactive: Boolean(auth.apiKey.login),
    });
  if (auth.oauth)
    methods.push({
      type: "oauth",
      label: auth.oauth.loginLabel ?? auth.oauth.name,
      interactive: true,
    });
  return methods;
}
