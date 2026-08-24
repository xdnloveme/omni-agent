import { isAbsolute, relative, sep } from "node:path";
import type {
  AccessResource,
  FilesystemCapabilityScope,
  FilesystemConsentCandidate,
} from "./types";

type FilesystemResource = Extract<AccessResource, { kind: "filesystem" }>;

export const MAX_APPROVED_FILESYSTEM_ROOTS = 64;

export function capabilityCoversResource(
  capability: FilesystemCapabilityScope,
  resource: FilesystemResource,
): boolean {
  if (!accessCovers(capability.access, resource.access)) return false;
  if (resource.scope === "subtree" && capability.scope !== "subtree") return false;
  if (resource.sensitivity === "protected") return false;
  if (resource.sensitivity === "sensitive") {
    return (
      resource.access === "read" &&
      capability.access === "read" &&
      capability.scope === "exact" &&
      capability.path === resource.path
    );
  }
  return capabilityCoversPath(capability, resource.path);
}

export function candidateCanAuthorize(
  candidate: FilesystemConsentCandidate,
  resource: FilesystemResource,
): boolean {
  if (!isConsentCandidateEligible(candidate)) return false;
  return capabilityCoversResource(candidate.capability, resource);
}

export function isConsentCandidateEligible(candidate: FilesystemConsentCandidate): boolean {
  const { capability, sensitivity } = candidate;
  if (!isAbsolute(capability.path) || sensitivity === "protected") return false;
  if (sensitivity === "sensitive") {
    return capability.access === "read" && capability.scope === "exact";
  }
  return true;
}

export function selectNarrowestCapability(
  capabilities: readonly FilesystemCapabilityScope[],
  resource: FilesystemResource,
): FilesystemCapabilityScope | undefined {
  return capabilities
    .filter((candidate) => capabilityCoversResource(candidate, resource))
    .sort(compareCapabilitySpecificity)[0];
}

export function normalizeFilesystemCapabilities(
  capabilities: readonly FilesystemCapabilityScope[],
): readonly FilesystemCapabilityScope[] {
  const byIdentity = new Map<string, FilesystemCapabilityScope>();
  for (const capability of capabilities) {
    if (!isAbsolute(capability.path))
      throw new Error("Filesystem capability paths must be absolute");
    const key = `${capability.path}\0${capability.scope}`;
    const existing = byIdentity.get(key);
    if (!existing || capability.access === "read_write") byIdentity.set(key, capability);
  }

  const entries = [...byIdentity.values()];
  return entries
    .filter((candidate) => {
      if (candidate.scope !== "subtree") return true;
      return !entries.some(
        (other) =>
          other !== candidate &&
          other.scope === "subtree" &&
          accessCovers(other.access, candidate.access === "read_write" ? "write" : "read") &&
          other.path !== candidate.path &&
          capabilityCoversPath(other, candidate.path),
      );
    })
    .sort(compareCapabilitiesStable);
}

export function capabilityKey(capability: FilesystemCapabilityScope): string {
  return `${capability.access}\0${capability.scope}\0${capability.path}`;
}

function capabilityCoversPath(capability: FilesystemCapabilityScope, target: string): boolean {
  if (capability.scope === "exact") return capability.path === target;
  const child = relative(capability.path, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function accessCovers(
  capability: FilesystemCapabilityScope["access"],
  resource: FilesystemResource["access"],
): boolean {
  return resource === "read" || capability === "read_write";
}

function compareCapabilitySpecificity(
  left: FilesystemCapabilityScope,
  right: FilesystemCapabilityScope,
): number {
  if (left.scope !== right.scope) return left.scope === "exact" ? -1 : 1;
  if (left.path.length !== right.path.length) return right.path.length - left.path.length;
  if (left.access !== right.access) return left.access === "read" ? -1 : 1;
  return left.path.localeCompare(right.path);
}

function compareCapabilitiesStable(
  left: FilesystemCapabilityScope,
  right: FilesystemCapabilityScope,
): number {
  return capabilityKey(left).localeCompare(capabilityKey(right));
}
