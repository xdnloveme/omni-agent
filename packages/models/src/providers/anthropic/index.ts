import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ModelCacheCapability } from "@omni-agent/core";
import { defineVendor } from "../../vendors/define-vendor";
import { nativeConnection } from "../factories/native";

const cacheCapability: ModelCacheCapability = {
  mode: "explicit_breakpoint",
  retentions: ["none", "short", "long"],
  stableScopeRetentions: [],
  shortTtlMs: 5 * 60 * 1000,
  longTtlMs: 60 * 60 * 1000,
};

export function anthropicVendorPlugin() {
  return defineVendor({
    id: "anthropic",
    displayName: "Anthropic",
    pluginId: "builtin.anthropic",
    connections: [
      nativeConnection(
        { id: "default", displayName: "Anthropic API", providerId: "anthropic" },
        anthropicProvider,
        { cacheCapability },
      ),
    ],
  });
}
