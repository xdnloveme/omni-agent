import type { AccessSensitivity, HostRuntimeContext, ToolAccessIntent } from "@omni-agent/core";
import { inspectPathSecurity } from "../../security/path/inspect-path-security";
import { evaluateFilesystemScopePolicy } from "../../security/path/filesystem-scope-policy";

export async function assessFilesystemAccess(
  value: string,
  cwd: string,
  access: "read" | "write",
  environment: HostRuntimeContext,
): Promise<ToolAccessIntent> {
  const inspection = await inspectPathSecurity(value, cwd, environment);
  const { consentCandidate } = await evaluateFilesystemScopePolicy(
    inspection,
    cwd,
    access,
    environment,
  );
  return {
    resources: [
      {
        kind: "filesystem",
        access,
        path: inspection.target,
        scope: "exact",
        location: inspection.inWorkspace ? "workspace" : "external",
        sensitivity: toAccessSensitivity(inspection.sensitivity),
      },
    ],
    ...(consentCandidate ? { controlledConsentCandidates: [consentCandidate] } : {}),
  };
}

export function toAccessSensitivity(
  sensitivity: Awaited<ReturnType<typeof inspectPathSecurity>>["sensitivity"],
): AccessSensitivity {
  if (sensitivity === "device" || sensitivity === "virtual_system") return "protected";
  return sensitivity ? "sensitive" : "ordinary";
}
