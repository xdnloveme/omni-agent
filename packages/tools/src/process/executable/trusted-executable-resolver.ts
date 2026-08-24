import type { SandboxPolicy } from "@omni-agent/core";
import { findExecutable } from "./executable-lookup";
import { assertExecutableTrusted } from "./executable-trust-policy";
import type { ExecutableRequirement, HostRuntimeSnapshot, ResolvedExecutable } from "./types";

export async function resolveTrustedExecutable(
  requirement: ExecutableRequirement,
  snapshot: HostRuntimeSnapshot,
  policy: SandboxPolicy,
  signal?: AbortSignal,
): Promise<ResolvedExecutable> {
  const executable = await findExecutable(requirement.command, requirement.cwd, snapshot, signal);
  assertExecutableTrusted(executable, requirement, policy, snapshot);
  return executable;
}
