import {
  capabilityCoversResource,
  type ToolAccessContext,
  type ToolAccessIntent,
} from "@omni-agent/core";
import { inspectPathSecurity } from "../../security/path/inspect-path-security";
import { evaluateFilesystemScopePolicy } from "../../security/path/filesystem-scope-policy";
import { toAccessSensitivity } from "../../filesystem/access/filesystem-access-assessor";
import { analyzeShellCommand } from "../security/analysis";

interface RequestedScope {
  readonly path: string;
  readonly scope: "exact" | "subtree";
}

export async function analyzeShellAccess(
  input: Record<string, unknown>,
  context: ToolAccessContext,
): Promise<ToolAccessIntent> {
  const command = input.command;
  if (typeof command !== "string") throw new Error("command must be a string");
  const analysis = await analyzeShellCommand({
    command,
    cwd: context.cwd,
    workspaceRoot: context.workspaceRoot,
    signal: context.signal,
    environment: context.hostRuntime,
  });
  const resources: ToolAccessIntent["resources"][number][] = [{ kind: "process" }];
  const controlledConsentCandidates: NonNullable<
    ToolAccessIntent["controlledConsentCandidates"]
  >[number][] = [];
  let invalidScope: { code: string; reason: string } | undefined;
  const requested = parseRequestedScope(input.sandbox_scope);
  for (const scope of requested.read) {
    const inspected = await inspectRequestedScope(scope, "read", context);
    resources.push(inspected.resource);
    if (inspected.consent) controlledConsentCandidates.push(inspected.consent);
    invalidScope ??= inspected.denial;
  }
  for (const scope of requested.write) {
    const inspected = await inspectRequestedScope(scope, "write", context);
    resources.push(inspected.resource);
    if (inspected.consent) controlledConsentCandidates.push(inspected.consent);
    invalidScope ??= inspected.denial;
  }
  for (const fact of analysis.paths.filter((candidate) => candidate.location === "workspace")) {
    const observed = {
      kind: "filesystem" as const,
      access: fact.access === "unknown" ? ("read" as const) : fact.access,
      path: fact.path,
      scope: "exact" as const,
      location: "workspace" as const,
      sensitivity: toAccessSensitivity(fact.sensitivity),
    };
    // Permission coverage must not erase exact targets used by instruction discovery.
    resources.push(observed);
  }
  const uncoveredResources = analysis.paths
    .filter((fact) => fact.access !== "unknown" && fact.location === "external")
    .map((fact) => ({
      kind: "filesystem" as const,
      access: fact.access as "read" | "write",
      path: fact.path,
      scope: "exact" as const,
      location: fact.location,
      sensitivity: toAccessSensitivity(fact.sensitivity),
    }))
    .filter((observed) => !resources.some((declared) => covers(declared, observed)));
  for (const target of requested.networkTargets) {
    resources.push({ kind: "network", target, purpose: "Bash command network access" });
  }
  const missingNetworkScope =
    analysis.effects.includes("network_transfer") && requested.networkTargets.length === 0;
  const unknownMutation = analysis.uncertainties.some(
    (fact) =>
      fact.kind === "mutation" ||
      fact.kind === "execution_target" ||
      fact.kind === "unsupported_syntax" ||
      fact.kind === "analysis_limit",
  );
  const mayMutate =
    unknownMutation ||
    analysis.paths.some((fact) => fact.access === "write") ||
    analysis.commands.some((command) => command.pathAccess !== "read");
  const boundedMutation =
    requested.write.length > 0 ||
    (!unknownMutation && analysis.paths.some((path) => path.access === "write"));
  return {
    resources,
    executableRequirements: executableRequirements(analysis.commands),
    filesystemMutation: mayMutate ? (boundedMutation ? "bounded" : "unbounded") : "none",
    ...(controlledConsentCandidates.length > 0 ? { controlledConsentCandidates } : {}),
    ...(uncoveredResources.length > 0 ? { uncoveredResources } : {}),
    ...(invalidScope ? { denial: invalidScope } : {}),
    ...(missingNetworkScope ? { networkScopeRequired: true } : {}),
    ...(analysis.security.hardStop ? { hardStop: analysis.security.hardStop } : {}),
  };
}

function executableRequirements(
  commands: Awaited<ReturnType<typeof analyzeShellCommand>>["commands"],
): NonNullable<ToolAccessIntent["executableRequirements"]> {
  return commands.flatMap((command) => {
    if (command.executionKind !== "external" || !command.executableToken) return [];
    return [
      {
        kind: "host_command" as const,
        command: command.executableToken,
        cwd: command.effectiveCwd,
        origin: "shell_command" as const,
      },
    ];
  });
}

function covers(
  declared: ToolAccessIntent["resources"][number],
  observed: Extract<ToolAccessIntent["resources"][number], { kind: "filesystem" }>,
): boolean {
  if (declared.kind !== "filesystem") return false;
  return capabilityCoversResource(
    {
      path: declared.path,
      scope: declared.scope,
      access: declared.access === "write" ? "read_write" : "read",
    },
    observed,
  );
}

async function inspectRequestedScope(
  scope: RequestedScope,
  access: "read" | "write",
  context: ToolAccessContext,
): Promise<{
  resource: Extract<ToolAccessIntent["resources"][number], { kind: "filesystem" }>;
  consent?: NonNullable<ToolAccessIntent["controlledConsentCandidates"]>[number];
  denial?: { code: string; reason: string };
}> {
  const inspection = await inspectPathSecurity(scope.path, context, context.hostRuntime);
  const policy = await evaluateFilesystemScopePolicy(
    inspection,
    context,
    access,
    context.hostRuntime,
    scope.scope,
  );
  return {
    resource: {
      kind: "filesystem",
      access,
      path: inspection.target,
      scope: scope.scope,
      location: inspection.inWorkspace ? "workspace" : "external",
      sensitivity: toAccessSensitivity(inspection.sensitivity),
    },
    ...(policy.consentCandidate ? { consent: policy.consentCandidate } : {}),
    ...(policy.denial ? { denial: policy.denial } : {}),
  };
}

function parseRequestedScope(value: unknown): {
  read: readonly RequestedScope[];
  write: readonly RequestedScope[];
  networkTargets: readonly { scheme: "http" | "https"; host: string; port: number }[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { read: [], write: [], networkTargets: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    read: parsePaths(record.read_paths),
    write: parsePaths(record.write_paths),
    networkTargets: parseNetworkTargets(record.network_targets),
  };
}

function parseNetworkTargets(
  value: unknown,
): readonly { scheme: "http" | "https"; host: string; port: number }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("network_targets must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid network target");
    }
    const candidate = entry as Record<string, unknown>;
    if (
      (candidate.scheme !== "http" && candidate.scheme !== "https") ||
      typeof candidate.host !== "string" ||
      !Number.isInteger(candidate.port) ||
      (candidate.port as number) < 1 ||
      (candidate.port as number) > 65_535
    ) {
      throw new Error("Invalid network target");
    }
    return {
      scheme: candidate.scheme,
      host: candidate.host,
      port: candidate.port as number,
    };
  });
}

function parsePaths(value: unknown): readonly RequestedScope[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const candidate = entry as Record<string, unknown>;
    if (
      !candidate ||
      typeof candidate.path !== "string" ||
      (candidate.scope !== "exact" && candidate.scope !== "subtree")
    ) {
      throw new Error("Invalid sandbox path scope");
    }
    return { path: candidate.path, scope: candidate.scope };
  });
}
