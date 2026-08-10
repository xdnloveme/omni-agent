import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { defineVendor } from "../../vendors/define-vendor";
import { nativeConnection } from "../factories/native";

export function moonshotVendorPlugin() {
  return defineVendor({
    id: "moonshot",
    displayName: "Moonshot AI",
    pluginId: "builtin.moonshot",
    connections: [
      nativeConnection(
        { id: "global", displayName: "Global", providerId: "moonshotai" },
        moonshotaiProvider,
      ),
      nativeConnection(
        { id: "cn", displayName: "China", providerId: "moonshotai-cn" },
        moonshotaiCnProvider,
      ),
      nativeConnection(
        { id: "kimi-coding", displayName: "Kimi For Coding", providerId: "kimi-coding" },
        kimiCodingProvider,
      ),
    ],
  });
}
