import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { automaticShortCache } from "../../cache/profiles";
import { defineVendor } from "../../vendors/define-vendor";
import { nativeConnection } from "../factories/native";

export function deepseekVendorPlugin() {
  return defineVendor({
    id: "deepseek",
    displayName: "DeepSeek",
    pluginId: "builtin.deepseek",
    connections: [
      nativeConnection(
        { id: "default", displayName: "DeepSeek API", providerId: "deepseek" },
        deepseekProvider,
        { cacheCapability: automaticShortCache },
      ),
    ],
  });
}
