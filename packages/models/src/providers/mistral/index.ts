import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { stableAutomaticShortCache } from "../../cache/profiles";
import { defineVendor } from "../../vendors/define-vendor";
import { nativeConnection } from "../factories/native";

export function mistralVendorPlugin() {
  return defineVendor({
    id: "mistral",
    displayName: "Mistral AI",
    pluginId: "builtin.mistral",
    connections: [
      nativeConnection(
        { id: "default", displayName: "Mistral API", providerId: "mistral" },
        mistralProvider,
        { cacheCapability: stableAutomaticShortCache },
      ),
    ],
  });
}
