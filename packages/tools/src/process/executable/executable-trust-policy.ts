import path from "node:path";
import type { SandboxPathScope, SandboxPolicy } from "@omni-agent/core";
import { isWithinPath } from "../../security/path/path-boundary";
import { SandboxProcessError } from "../sandbox-process-error";
import { isSystemRuntimePath } from "./platform/system-runtime-paths";
import type { ExecutableRequirement, HostRuntimeSnapshot, ResolvedExecutable } from "./types";

/** Applies provenance-aware trust after mechanical executable lookup. */
export function assertExecutableTrusted(
  executable: ResolvedExecutable,
  requirement: ExecutableRequirement,
  policy: SandboxPolicy,
  snapshot: HostRuntimeSnapshot,
): void {
  const canonical = executable.canonicalExecutablePath;
  if (isAuthorizedPath(canonical, policy, snapshot.platform)) return;
  if (executable.lookupSource === "immutable_path") return;

  if (requirement.origin === "interpreter" || requirement.origin === "script_dependency") {
    if (
      requirement.parentRuntimeScopes.some((scope) =>
        scopeCovers(scope, canonical, snapshot.platform),
      ) ||
      isDirectImmutablePathMember(executable.executablePath, snapshot)
    ) {
      return;
    }
  }

  throw new SandboxProcessError(
    "sandbox_runtime_projection_failed",
    executable.lookupSource === "relative_path"
      ? "A relative PATH entry resolved outside the current filesystem scope."
      : "Executable paths outside the trusted PATH must be covered by the current filesystem scope.",
  );
}

function isAuthorizedPath(
  candidate: string,
  policy: SandboxPolicy,
  platform: NodeJS.Platform,
): boolean {
  if (isWithinPath(candidate, policy.workspaceRoot, platform)) return true;
  if (isSystemRuntimePath(candidate, platform)) return true;
  return [...policy.read, ...policy.write].some((scope) => scopeCovers(scope, candidate, platform));
}

function scopeCovers(
  scope: SandboxPathScope,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  return scope.scope === "exact"
    ? path.normalize(scope.path) === path.normalize(candidate)
    : isWithinPath(candidate, scope.path, platform);
}

function isDirectImmutablePathMember(candidate: string, snapshot: HostRuntimeSnapshot): boolean {
  const parent = path.dirname(path.normalize(candidate));
  return snapshot.pathEntries.some(
    (entry) => entry.kind === "absolute" && path.normalize(entry.path) === parent,
  );
}
