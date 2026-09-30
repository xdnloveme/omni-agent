import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompatibleModelDefinition, CompatibleProtocol } from "../custom/types";

interface ProviderModelContext {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly api: CompatibleProtocol | "omni-custom";
}

export function toProviderModel(
  definition: CompatibleModelDefinition,
  context: ProviderModelContext,
): Model<Api> {
  if (
    definition.supportsStrictMode !== undefined &&
    typeof definition.supportsStrictMode !== "boolean"
  )
    throw new Error("Model supportsStrictMode must be boolean");
  return {
    id: definition.id,
    name: definition.name ?? definition.id,
    api: context.api,
    provider: context.providerId,
    baseUrl: context.baseUrl,
    reasoning: definition.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
    ...(definition.supportsStrictMode === undefined
      ? {}
      : { compat: { supportsStrictMode: definition.supportsStrictMode } }),
  };
}
