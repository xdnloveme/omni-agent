import { stat } from "node:fs/promises";
import path from "node:path";
import { throwIfAborted, type SandboxPathScope } from "@omni-agent/core";
import { isWithinPath } from "../../security/path/path-boundary";
import { SandboxProcessError } from "../sandbox-process-error";
import type { HostRuntimeSnapshot, ResolvedExecutable } from "./types";

const PACKAGE_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml"] as const;
const INSTALL_DIRECTORIES = new Set(["bin", "sbin", "libexec"]);

export async function inferExecutableRuntimeScopes(
  executable: ResolvedExecutable,
  snapshot: HostRuntimeSnapshot,
  isScript: boolean,
  signal?: AbortSignal,
): Promise<readonly SandboxPathScope[]> {
  const scopes: SandboxPathScope[] = [
    { path: executable.executablePath, scope: "exact" },
    { path: executable.canonicalExecutablePath, scope: "exact" },
  ];
  const packageRoot = isScript
    ? await findNearestPackageRoot(executable.canonicalExecutablePath, snapshot, signal)
    : undefined;
  const installRoot = inferInstallRoot(executable.canonicalExecutablePath, snapshot);
  const runtimeRoot = packageRoot ?? (!isScript ? installRoot : undefined);
  if (runtimeRoot) {
    scopes.push({ path: runtimeRoot, scope: "subtree" });
  } else if (isScript && executable.pathEntry) {
    const owner = inferBoundedUserPathOwner(executable.pathEntry, snapshot);
    if (!owner) throw runtimeRootTooBroad();
    scopes.push({ path: owner, scope: "subtree" });
  }
  return scopes;
}

async function findNearestPackageRoot(
  executablePath: string,
  snapshot: HostRuntimeSnapshot,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let directory = path.dirname(executablePath);
  while (!isForbiddenBroadRoot(directory, snapshot)) {
    throwIfAborted(signal);
    for (const marker of PACKAGE_MARKERS) {
      try {
        const metadata = await stat(path.join(directory, marker));
        if (metadata.isFile()) return directory;
      } catch {
        // Missing or unreadable markers do not define a package boundary.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function inferInstallRoot(
  executablePath: string,
  snapshot: HostRuntimeSnapshot,
): string | undefined {
  const parent = path.dirname(executablePath);
  if (!INSTALL_DIRECTORIES.has(path.basename(parent))) return undefined;
  const candidate = path.dirname(parent);
  return isForbiddenBroadRoot(candidate, snapshot) ? undefined : candidate;
}

function inferBoundedUserPathOwner(
  pathEntry: string,
  snapshot: HostRuntimeSnapshot,
): string | undefined {
  const candidate = INSTALL_DIRECTORIES.has(path.basename(pathEntry))
    ? path.dirname(pathEntry)
    : pathEntry;
  if (isForbiddenBroadRoot(candidate, snapshot)) return undefined;
  const normalized = path.resolve(candidate);
  if (!isWithinPath(normalized, snapshot.home, snapshot.platform)) return undefined;
  return normalized;
}

function isForbiddenBroadRoot(candidate: string, snapshot: HostRuntimeSnapshot): boolean {
  const normalized = path.resolve(candidate);
  return (
    normalized === path.parse(normalized).root ||
    normalized === snapshot.home ||
    normalized === path.join(snapshot.home, "Library")
  );
}

function runtimeRootTooBroad(): SandboxProcessError {
  return new SandboxProcessError(
    "sandbox_runtime_projection_too_broad",
    "The script runtime root cannot be bounded safely.",
  );
}
