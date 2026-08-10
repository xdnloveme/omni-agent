import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { defineVendor } from "../../vendors/define-vendor";
import { nativeConnection } from "../factories/native";

export function anthropicVendorPlugin() {
  return defineVendor({
    id: "anthropic",
    displayName: "Anthropic",
    pluginId: "builtin.anthropic",
    connections: [
      nativeConnection(
        { id: "default", displayName: "Anthropic API", providerId: "anthropic" },
        anthropicProvider,
      ),
    ],
  });
}
