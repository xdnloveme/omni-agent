import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelCacheCapability } from "@omni-agent/core";
import { readCompatBoolean } from "../../cache/capability";
import { automaticShortCache } from "../../cache/profiles";
import { defineVendor } from "../../vendors/define-vendor";
import type { ProviderCacheModel } from "../../vendors/provider-contribution-type";
import { nativeConnection } from "../factories/native";

export function openAiCacheCapability(model: ProviderCacheModel): ModelCacheCapability {
  const exactThirtyMinuteCache =
    readCompatBoolean(model.compat, "supportsExplicitPromptCacheMode") === true;
  if (
    !exactThirtyMinuteCache &&
    readCompatBoolean(model.compat, "supportsLongCacheRetention") === true
  ) {
    return {
      mode: "automatic_prefix",
      retentions: ["none", "short", "long"],
      stableScopeRetentions: ["short", "long"],
      longTtlMs: 24 * 60 * 60 * 1000,
    };
  }
  return {
    ...automaticShortCache,
    stableScopeRetentions: ["short"],
    ...(exactThirtyMinuteCache ? { shortTtlMs: 30 * 60 * 1000 } : {}),
  };
}

export function openaiVendorPlugin() {
  return defineVendor({
    id: "openai",
    displayName: "OpenAI",
    pluginId: "builtin.openai",
    connections: [
      nativeConnection(
        { id: "default", displayName: "OpenAI API", providerId: "openai" },
        openaiProvider,
        { cacheCapability: openAiCacheCapability },
      ),
    ],
  });
}
