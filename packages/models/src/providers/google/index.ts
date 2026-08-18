import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import type { ModelCacheCapability } from "@omni-agent/core";
import { automaticShortCache, noCache } from "../../cache/profiles";
import { defineVendor } from "../../vendors/define-vendor";
import type { ProviderCacheModel } from "../../vendors/provider-contribution-type";
import { nativeConnection } from "../factories/native";

export function googleCacheCapability(model: ProviderCacheModel): ModelCacheCapability {
  // https://ai.google.dev/gemini-api/docs/caching
  return /^gemini-(?:2\.(?:[5-9]|\d{2,})|[3-9]|\d{2,})/.test(model.id)
    ? automaticShortCache
    : noCache;
}

export function googleVendorPlugin() {
  return defineVendor({
    id: "google",
    displayName: "Google",
    pluginId: "builtin.google",
    connections: [
      nativeConnection(
        { id: "default", displayName: "Gemini API", providerId: "google" },
        googleProvider,
        { cacheCapability: googleCacheCapability },
      ),
    ],
  });
}
