import { randomBytes } from "node:crypto";
import type { ProcessInvocation, SandboxPathScope, SandboxPolicy } from "@omni-agent/core";
import type { createSensitiveReadPolicySnapshot } from "../security/path/sensitive-policy-snapshot";
import { SandboxProcessError } from "./sandbox-process-error";
import { SANDBOX_PROTOCOL_VERSION } from "./sandbox-protocol";

const MAX_PROTOCOL_ENTRIES = 256;

interface CompileSandboxArgumentsInput {
  readonly invocation: ProcessInvocation;
  readonly policy: SandboxPolicy;
  readonly privateTemp: string;
  readonly runtimeRead: readonly SandboxPathScope[];
  readonly systemRead: readonly SandboxPathScope[];
  readonly sensitive: ReturnType<typeof createSensitiveReadPolicySnapshot>;
}

export interface CompiledSandboxInvocation {
  readonly arguments: readonly string[];
  readonly diagnosticToken: string;
}

export function compileSandboxInvocation(
  input: CompileSandboxArgumentsInput,
): CompiledSandboxInvocation {
  const read = uniqueScopes([...input.systemRead, ...input.runtimeRead, ...input.policy.read]);
  const write = uniqueScopes(input.policy.write);
  assertProtocolBudget(input, read.length + write.length);
  const diagnosticToken = randomBytes(16).toString("hex");
  return {
    diagnosticToken,
    arguments: [
      "--protocol-version",
      SANDBOX_PROTOCOL_VERSION,
      "--diagnostic-token",
      diagnosticToken,
      "--mode",
      input.policy.mode,
      "--workspace",
      input.policy.workspaceRoot,
      "--private-temp",
      input.privateTemp,
      "--network",
      input.policy.network ? "enabled" : "disabled",
      ...scopeArguments("read", read),
      ...scopeArguments("write", write),
      ...input.policy.protectedWriteRoots.flatMap((target) => ["--protect-write-root", target]),
      ...input.sensitive.deniedSubtrees.flatMap((target) => ["--deny-read-subtree", target]),
      ...input.sensitive.deniedExactNames.flatMap((name) => ["--deny-read-name", name]),
      ...input.sensitive.deniedNamePrefixes.flatMap((prefix) => ["--deny-read-prefix", prefix]),
      ...input.sensitive.allowedTemplateNames.flatMap((name) => ["--allow-read-name", name]),
      ...input.sensitive.approvedExactPaths.flatMap((target) => [
        "--allow-sensitive-read-exact",
        target,
      ]),
      "--",
      input.invocation.command,
      ...input.invocation.args,
    ],
  };
}

function assertProtocolBudget(input: CompileSandboxArgumentsInput, pathScopeCount: number): void {
  const entries =
    pathScopeCount +
    input.policy.protectedWriteRoots.length +
    input.sensitive.deniedSubtrees.length +
    input.sensitive.deniedExactNames.length +
    input.sensitive.deniedNamePrefixes.length +
    input.sensitive.allowedTemplateNames.length +
    input.sensitive.approvedExactPaths.length;
  if (entries > MAX_PROTOCOL_ENTRIES) {
    throw new SandboxProcessError(
      "sandbox_runtime_projection_limit",
      "The combined sandbox policy exceeds the protocol entry limit.",
    );
  }
}

function scopeArguments(access: "read" | "write", scopes: readonly SandboxPathScope[]): string[] {
  return scopes.flatMap(({ path, scope }) => [`--${access}-${scope}`, path]);
}

function uniqueScopes(scopes: readonly SandboxPathScope[]): readonly SandboxPathScope[] {
  return [
    ...new Map(scopes.map((scope) => [`${scope.scope}\0${scope.path}`, scope])).values(),
  ].sort((left, right) =>
    `${left.scope}\0${left.path}`.localeCompare(`${right.scope}\0${right.path}`),
  );
}
