import type { PermissionAssessment, ToolPermissionDescriptor } from "@omni-agent/core";

export function createWebReadPermission(options: {
  parameter: string;
  title: string;
  valueKind: "url" | "text";
}): ToolPermissionDescriptor {
  return {
    kind: "dynamic",
    assess(input) {
      const value = input[options.parameter];
      if (typeof value !== "string") throw new Error(`${options.parameter} must be a string`);
      if (options.valueKind === "url") return assessUrl(value, options.title);
      return externalRead(options.title, value);
    },
  };
}

function assessUrl(value: string, title: string): PermissionAssessment {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return hardDeny(title, value, "URL is invalid", "web.invalid-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return hardDeny(
      title,
      value,
      "Only HTTP and HTTPS URLs are allowed",
      "web.unsupported-protocol",
    );
  }
  return externalRead(title, value);
}

function externalRead(title: string, detail: string): PermissionAssessment {
  return {
    risk: "external_read",
    enforcement: "policy",
    reasons: ["Reads information from an external service"],
    ruleIds: ["web.external-read"],
    presentation: { title, detail, reason: "Reads information from an external service" },
  };
}

function hardDeny(
  title: string,
  detail: string,
  reason: string,
  ruleId: string,
): PermissionAssessment {
  return {
    risk: "privileged",
    enforcement: "hard_deny",
    reasons: [reason],
    ruleIds: [ruleId],
    presentation: { title, detail, reason },
  };
}
