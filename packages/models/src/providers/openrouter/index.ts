import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { automaticShortCache } from "../../cache/profiles";
import { defineVendor } from "../../vendors/define-vendor";
import { nativeConnection } from "../factories/native";

export function openrouterVendorPlugin() {
  return defineVendor({
    id: "openrouter",
    displayName: "OpenRouter",
    pluginId: "builtin.openrouter",
    connections: [
      nativeConnection(
        { id: "default", displayName: "OpenRouter", providerId: "openrouter" },
        openrouterProvider,
        { cacheCapability: automaticShortCache },
      ),
    ],
  });
}
