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
        return {
          resources: [
            {
              kind: "network",
              target: {
                scheme: url.protocol === "https:" ? "https" : "http",
                host: url.hostname,
                port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
              },
              purpose: "Fetch the requested URL",
            },
          ],
        };
      }
      return {
        resources: [
          {
            kind: "network",
            target: { scheme: "https", host: "html.duckduckgo.com", port: 443 },
            purpose: "Search the web with DuckDuckGo",
          },
        ],
      };
    },
  };
}

function deny(code: string, reason: string) {
  return { resources: [], denial: { code, reason } };
}
