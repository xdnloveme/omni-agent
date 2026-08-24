import type { ToolAccessDescriptor } from "@omni-agent/core";

export function createWebAccess(options: {
  parameter: string;
  valueKind: "url" | "text";
}): ToolAccessDescriptor {
  return {
    kind: "dynamic",
    assess(input) {
      const value = input[options.parameter];
      if (typeof value !== "string") throw new Error(`${options.parameter} must be a string`);
      if (options.valueKind === "url") {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return deny("web_invalid_url", "URL is invalid");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return deny("web_unsupported_protocol", "Only HTTP and HTTPS URLs are allowed");
        }
      }
      return { resources: [{ kind: "network" }] };
    },
  };
}

function deny(code: string, reason: string) {
  return { resources: [], denial: { code, reason } };
}
