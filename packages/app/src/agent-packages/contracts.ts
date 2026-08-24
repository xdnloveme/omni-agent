import type { LoadedAgentPackage } from "../assembly/contracts";

export interface AgentPackageDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly packageName: string;
  readonly packageVersion: string;
}

export interface AgentPackageModule {
  readonly agentBlueprint?: unknown;
}

export interface AgentPackageRegistration {
  readonly agentId: string;
  readonly loadModule: () => Promise<AgentPackageModule>;
  readonly bundledManifest?: string;
  readonly bundledPackageVersion?: string;
}

export interface AgentPackageCatalogPort {
  list(): Promise<readonly AgentPackageDescriptor[]>;
  load(agentId: string): Promise<LoadedAgentPackage>;
}

export type AgentPackageCatalogErrorCode =
  | "agent_not_registered"
  | "agent_manifest_not_found"
  | "agent_manifest_invalid"
  | "agent_package_incompatible"
  | "agent_identity_mismatch"
  | "agent_blueprint_missing"
  | "agent_blueprint_invalid"
  | "agent_package_load_failed";

export class AgentPackageCatalogError extends Error {
  constructor(
    readonly code: AgentPackageCatalogErrorCode,
    message: string,
    readonly agentId: string,
    readonly packageName: string,
    readonly source: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentPackageCatalogError";
  }
}
