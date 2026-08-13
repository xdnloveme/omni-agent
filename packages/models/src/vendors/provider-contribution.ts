import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import type { ModelCacheCapability } from "@omni-agent/core";
import type { ModelAuthMethod } from "../credentials/types";
import { providerContributionBrand, type ProviderContribution } from "./provider-contribution-type";

const providers = new WeakMap<ProviderContribution, Provider>();

export function createProviderContribution(
  provider: Provider,
  credentialAliases: readonly string[] = [],
  cacheCapability?: ModelCacheCapability,
): ProviderContribution {
  if (!provider.id.trim()) throw new Error("Provider id is required");
  if (!provider.auth.apiKey && !provider.auth.oauth) {
    throw new Error(`Provider has no auth: ${provider.id}`);
  }
  if (cacheCapability) validateCacheCapability(cacheCapability);
  const contribution = {
    id: provider.id,
    credentialAliases: [...new Set(credentialAliases)],
    ...(cacheCapability
      ? { cacheCapability: { ...cacheCapability, retentions: [...cacheCapability.retentions] } }
      : {}),
    [providerContributionBrand]: true as const,
  };
  providers.set(contribution, provider);
  return contribution;
}

function validateCacheCapability(capability: ModelCacheCapability): void {
  if (!["none", "automatic_prefix", "explicit_breakpoint"].includes(capability.mode)) {
    throw new Error(`Invalid model cache mode: ${String(capability.mode)}`);
  }
  if (
    !Array.isArray(capability.retentions) ||
    capability.retentions.length === 0 ||
    !capability.retentions.includes("none") ||
    capability.retentions.some((retention) => !["none", "short", "long"].includes(retention)) ||
    new Set(capability.retentions).size !== capability.retentions.length
  ) {
    throw new Error("Invalid model cache retentions");
  }
  if (typeof capability.supportsStableScopeKey !== "boolean") {
    throw new Error("Invalid model cache stable-scope capability");
  }
  for (const ttl of [capability.shortTtlMs, capability.longTtlMs]) {
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
      throw new Error("Invalid model cache TTL");
    }
  }
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
