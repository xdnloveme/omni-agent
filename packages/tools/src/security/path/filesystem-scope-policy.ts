import { dirname } from "node:path";
import type {
  FilesystemCapabilityScope,
  FilesystemConsentCandidate,
  HostRuntimeContext,
} from "@omni-agent/core";
import type { PathSecurityInspection } from "./inspect-path-security";
import { inspectPathSecurity } from "./inspect-path-security";
import { isWithinPath } from "./path-boundary";
import { createSensitivePathPolicy } from "./sensitive-paths";

export interface FilesystemScopePolicyResult {
  readonly consentCandidate?: FilesystemConsentCandidate;
  readonly denial?: { readonly code: string; readonly reason: string };
}

export async function evaluateFilesystemScopePolicy(
  inspection: PathSecurityInspection,
  cwd: string,
  access: "read" | "write",
  environment: HostRuntimeContext,
  requestedScope?: "exact" | "subtree",
): Promise<FilesystemScopePolicyResult> {
  if (
    requestedScope &&
    ((requestedScope === "subtree" && inspection.targetKind !== "directory") ||
      (requestedScope === "exact" && inspection.targetKind === "directory") ||
      inspection.targetKind === "special" ||
      inspection.targetKind === "dangling_symlink")
  ) {
    return {
      denial: {
        code: "sandbox_scope_invalid",
        reason:
          requestedScope === "subtree"
            ? "A subtree sandbox scope must reference an existing directory."
            : "An exact sandbox scope must reference a file path.",
      },
    };
  }
  if (inspection.sensitivity === "device" || inspection.sensitivity === "virtual_system") {
    return {};
  }
  if (inspection.sensitivity) {
    if (access === "write" || inspection.targetKind === "directory") return {};
    return {
      consentCandidate: candidate(
        { path: inspection.target, scope: "exact", access: "read" },
        "sensitive",
      ),
    };
  }
  if (inspection.inWorkspace) return {};

  const home = await inspectPathSecurity(environment.home, cwd, environment);
  if (requestedScope) {
    if (
      requestedScope === "subtree" &&
      containsProtectedBoundary(inspection.target, home.target, environment)
    ) {
      return {
        denial: {
          code: "sandbox_scope_too_broad",
          reason: "The requested subtree contains a protected filesystem boundary.",
        },
      };
    }
    return {
      consentCandidate: candidate(
        {
          path: inspection.target,
          scope: requestedScope,
          access: access === "write" ? "read_write" : "read",
        },
        "ordinary",
      ),
    };
  }

  const proposedRoot =
    inspection.targetKind === "directory" ? inspection.target : dirname(inspection.target);
  const parentInspection =
    inspection.targetKind === "directory"
      ? inspection
      : await inspectPathSecurity(proposedRoot, cwd, environment);
  const canUseSubtree =
    !parentInspection.sensitivity &&
    !containsProtectedBoundary(parentInspection.target, home.target, environment);
  if (!canUseSubtree && inspection.targetKind === "directory") return {};
  return {
    consentCandidate: candidate(
      {
        path: canUseSubtree ? parentInspection.target : inspection.target,
        scope: canUseSubtree ? "subtree" : "exact",
        access: access === "write" ? "read_write" : "read",
      },
      "ordinary",
    ),
  };
}

function containsProtectedBoundary(
  root: string,
  home: string,
  environment: HostRuntimeContext,
): boolean {
  const policy = createSensitivePathPolicy(environment);
  return [
    home,
    ...policy.credentialDirectories,
    ...policy.systemDirectories,
    ...policy.virtualSystemDirectories,
    ...policy.deviceDirectories,
  ].some((protectedPath) => isWithinPath(protectedPath, root, environment.platform));
}

function candidate(
  capability: FilesystemCapabilityScope,
  sensitivity: FilesystemConsentCandidate["sensitivity"],
): FilesystemConsentCandidate {
  return { capability, sensitivity };
}
