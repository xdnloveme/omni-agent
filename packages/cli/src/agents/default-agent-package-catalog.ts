import { join } from "node:path";
import { AgentPackageCatalog, type AgentPackageRegistration } from "@omni-agent/app";
import { loadBuiltinAgentPackage } from "./builtin-agent-loaders";

const BUILTIN_AGENT_IDS = ["coding", "financial-analysis"] as const;

export interface DefaultAgentPackageCatalogOptions {
  readonly resolutionBase?: string;
  readonly agentPackagesDirectory?: string;
}

export function createDefaultAgentPackageCatalog(
  options: DefaultAgentPackageCatalogOptions = {},
): AgentPackageCatalog {
  const manifests =
    typeof __OMNI_BUILTIN_AGENT_MANIFESTS__ === "undefined"
      ? undefined
      : __OMNI_BUILTIN_AGENT_MANIFESTS__;
  const versions =
    typeof __OMNI_BUILTIN_AGENT_PACKAGE_VERSIONS__ === "undefined"
      ? undefined
      : __OMNI_BUILTIN_AGENT_PACKAGE_VERSIONS__;
  const registrations: AgentPackageRegistration[] = BUILTIN_AGENT_IDS.map((agentId) => ({
    agentId,
    loadModule: async () => {
      const loaded = loadBuiltinAgentPackage(agentId);
      if (!loaded) throw new Error(`Builtin Agent loader is missing: ${agentId}`);
      return loaded;
    },
    ...(manifests?.[agentId] !== undefined ? { bundledManifest: manifests[agentId] } : {}),
    ...(versions?.[agentId] !== undefined ? { bundledPackageVersion: versions[agentId] } : {}),
  }));
  return new AgentPackageCatalog({
    registrations,
    resolutionBases: [
      options.resolutionBase,
      options.agentPackagesDirectory
        ? join(options.agentPackagesDirectory, "module-resolver.cjs")
        : undefined,
      import.meta.filename,
    ].filter((value): value is string => Boolean(value)),
  });
}
