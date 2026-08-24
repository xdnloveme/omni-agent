import path from "node:path";
import type { SandboxPathScope } from "@omni-agent/core";
import { isWithinPath } from "../../../security/path/path-boundary";

const DARWIN_SUBTREES = [
  "/System",
  "/usr/bin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/sbin",
  "/usr/share",
  "/bin",
  "/sbin",
  "/Library/Apple",
  "/private/var/db/timezone",
  "/private/var/select",
];
const DARWIN_EXACT = [
  "/private/etc/group",
  "/private/etc/hosts",
  "/private/etc/passwd",
  "/private/etc/protocols",
  "/private/etc/resolv.conf",
  "/private/etc/services",
];
const DARWIN_PROJECTION: readonly SandboxPathScope[] = [
  ...DARWIN_SUBTREES.map((path) => ({ path, scope: "subtree" as const })),
  ...DARWIN_EXACT.map((path) => ({ path, scope: "exact" as const })),
];

export function systemRuntimeReadProjection(
  platform: NodeJS.Platform,
): readonly SandboxPathScope[] {
  return platform === "darwin" ? DARWIN_PROJECTION : [];
}

export function isSystemRuntimePath(candidate: string, platform: NodeJS.Platform): boolean {
  return systemRuntimeReadProjection(platform).some((scope) =>
    scope.scope === "exact"
      ? path.normalize(scope.path) === path.normalize(candidate)
      : isWithinPath(candidate, scope.path, platform),
  );
}
