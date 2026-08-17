import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentBlueprint } from "@omni-agent/app";
import { isAgentId } from "@omni-agent/core";
import { loadBuiltinAgentPackage } from "./builtin-agent-loaders";

interface AgentPackageModule {
  readonly agentBlueprint?: unknown;
}

export interface AgentBlueprintLoaderOptions {
  readonly resolutionBase?: string;
  readonly agentPackagesDirectory?: string;
}

export async function loadAgentBlueprint(
  agentId: string,
  options: AgentBlueprintLoaderOptions = {},
): Promise<AgentBlueprint> {
  assertAgentId(agentId);
  const packageName = `@omni-agent/agent-${agentId}`;
  let agentPackage: AgentPackageModule;
  try {
    agentPackage =
      (await loadBuiltinAgentPackage(agentId)) ??
      ((await importExternalAgentPackage(packageName, [
        options.resolutionBase ?? process.argv[1],
        join(
          options.agentPackagesDirectory ?? join(homedir(), ".omni-agent", "agents"),
          "module-resolver.cjs",
        ),
      ])) as AgentPackageModule);
  } catch (error) {
    throw new Error(`Unable to load agent package "${packageName}"`, { cause: error });
  }

  if (!isAgentBlueprint(agentPackage.agentBlueprint)) {
    throw new Error(`Agent package "${packageName}" does not export a valid agentBlueprint`);
  }
  if (agentPackage.agentBlueprint.id !== agentId) {
    throw new Error(
      `Agent blueprint id mismatch: expected ${agentId}, received ${agentPackage.agentBlueprint.id}`,
    );
  }
  return agentPackage.agentBlueprint;
}

async function importExternalAgentPackage(
  packageName: string,
  resolutionBases: readonly (string | undefined)[],
): Promise<unknown> {
  const bases: string[] = [];
  for (const resolutionBase of resolutionBases) {
    if (!resolutionBase) continue;
    const logicalBase = resolve(resolutionBase);
    bases.push(logicalBase);
    try {
      const physicalBase = await realpath(logicalBase);
      if (physicalBase !== logicalBase) bases.push(physicalBase);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (bases.length === 0) throw new Error("Agent package resolution base is unavailable");

  let entry: string | undefined;
  let lastResolutionError: unknown;
  for (const base of new Set(bases)) {
    try {
      entry = createRequire(base).resolve(packageName);
      break;
    } catch (error) {
      lastResolutionError = error;
    }
  }
  if (!entry) throw lastResolutionError;
  return import(pathToFileURL(entry).href);
}

function isAgentBlueprint(value: unknown): value is AgentBlueprint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentBlueprint>;
  return typeof candidate.id === "string" && typeof candidate.build === "function";
}

function assertAgentId(agentId: string): void {
  if (!isAgentId(agentId)) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
}
