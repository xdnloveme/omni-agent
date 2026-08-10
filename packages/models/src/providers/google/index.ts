import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { defineVendor } from "../../vendors/define-vendor";
import { nativeConnection } from "../factories/native";

export function googleVendorPlugin() {
  return defineVendor({
    id: "google",
    displayName: "Google",
    pluginId: "builtin.google",
    connections: [
      nativeConnection(
        { id: "default", displayName: "Gemini API", providerId: "google" },
        googleProvider,
      ),
    ],
  });
}
