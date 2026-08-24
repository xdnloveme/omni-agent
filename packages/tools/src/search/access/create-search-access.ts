import type { ToolAccessDescriptor } from "@omni-agent/core";
import { bindCanonicalPathInput } from "../../security/path/authorized-operation-path";
import { inspectPathSecurity } from "../../security/path/inspect-path-security";
import { evaluateFilesystemScopePolicy } from "../../security/path/filesystem-scope-policy";
import { toAccessSensitivity } from "../../filesystem/access/filesystem-access-assessor";

export function createSearchAccess(parameter: string): ToolAccessDescriptor {
  return {
    kind: "dynamic",
    bindInput: (input, context) =>
      bindCanonicalPathInput(input, parameter, context.cwd, { optional: true }),
    async assess(input, context) {
      const value = input[parameter] ?? context.cwd;
      if (typeof value !== "string") throw new Error(`${parameter} must be a string`);
      const inspection = await inspectPathSecurity(value, context.cwd, context.hostRuntime);
      const { consentCandidate } = await evaluateFilesystemScopePolicy(
        inspection,
        context.cwd,
        "read",
        context.hostRuntime,
      );
      return {
        resources: [
          {
            kind: "filesystem",
            access: "read",
            path: inspection.target,
            scope: inspection.targetKind === "directory" ? "subtree" : "exact",
            location: inspection.inWorkspace ? "workspace" : "external",
            sensitivity: toAccessSensitivity(inspection.sensitivity),
          },
          ...(parameter === "search_path" ? [{ kind: "process" as const }] : []),
        ],
        ...(consentCandidate ? { controlledConsentCandidates: [consentCandidate] } : {}),
      };
    },
  };
}
