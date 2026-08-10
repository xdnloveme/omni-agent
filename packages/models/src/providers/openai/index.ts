import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { defineVendor } from "../../vendors/define-vendor";
import { nativeConnection } from "../factories/native";

export function openaiVendorPlugin() {
  return defineVendor({
    id: "openai",
    displayName: "OpenAI",
    pluginId: "builtin.openai",
    connections: [
      nativeConnection(
        { id: "default", displayName: "OpenAI API", providerId: "openai" },
        openaiProvider,
      ),
    ],
  });
}
