import { createRequire } from "node:module";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isAgentId } from "@omni-agent/core";
import { parseAgentManifest, MAX_AGENT_MANIFEST_BYTES } from "../assembly/agent-manifest-validator";
import { validateAgentBlueprintDescriptor } from "../assembly/agent-blueprint-descriptor-validator";
import type { AgentBlueprint, LoadedAgentPackage } from "../assembly/contracts";
import {
  AgentPackageCatalogError,
  type AgentPackageCatalogPort,
  type AgentPackageDescriptor,
  type AgentPackageModule,
  type AgentPackageRegistration,
} from "./contracts";

export interface AgentPackageCatalogOptions {
  readonly registrations?: readonly AgentPackageRegistration[];
  readonly resolutionBases?: readonly string[];
}

interface ResolvedPackageMetadata {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly manifestSource: string;
  readonly rawManifest: string;
  readonly packageEntry?: string;
}

export class AgentPackageCatalog implements AgentPackageCatalogPort {
  private readonly registrations: ReadonlyMap<string, AgentPackageRegistration>;

  constructor(private readonly options: AgentPackageCatalogOptions = {}) {
    const registrations = new Map<string, AgentPackageRegistration>();
    for (const registration of options.registrations ?? []) {
      assertAgentId(registration.agentId);
      if (registrations.has(registration.agentId)) {
        const packageName = packageNameFor(registration.agentId);
        throw new AgentPackageCatalogError(
          "agent_identity_mismatch",
          `Agent package is registered more than once: ${registration.agentId}`,
          registration.agentId,
          packageName,
          packageName,
        );
      }
      if (
        (registration.bundledManifest === undefined) !==
        (registration.bundledPackageVersion === undefined)
      ) {
        const packageName = packageNameFor(registration.agentId);
        throw new AgentPackageCatalogError(
          "agent_package_incompatible",
          `Bundled Agent registration must provide both Manifest and package version: ${registration.agentId}`,
          registration.agentId,
          packageName,
          packageName,
        );
      }
      registrations.set(registration.agentId, registration);
    }
    this.registrations = registrations;
  }

  async list(): Promise<readonly AgentPackageDescriptor[]> {
    return Promise.all(
      [...this.registrations.values()].map(async (registration) => {
        const metadata = await this.resolveMetadata(registration.agentId, registration);
        const manifest = parseManifest(metadata, registration.agentId);
        return {
          id: manifest.metadata.id,
          displayName: manifest.metadata.displayName,
          description: manifest.description,
          packageName: metadata.packageName,
          packageVersion: metadata.packageVersion,
        };
      }),
    );
  }

  async load(agentId: string): Promise<LoadedAgentPackage> {
    assertAgentId(agentId);
    const registration = this.registrations.get(agentId);
    const metadata = await this.resolveMetadata(agentId, registration);
    const manifest = parseManifest(metadata, agentId);
    let packageModule: AgentPackageModule;
    try {
      if (registration) {
        packageModule = await registration.loadModule();
      } else if (metadata.packageEntry) {
        packageModule = (await import(
          pathToFileURL(metadata.packageEntry).href
        )) as AgentPackageModule;
      } else {
        throw new AgentPackageCatalogError(
          "agent_package_load_failed",
          `Agent package entry is unavailable: ${metadata.packageName}`,
          agentId,
          metadata.packageName,
          metadata.packageName,
        );
      }
    } catch (error) {
      throw new AgentPackageCatalogError(
        "agent_package_load_failed",
        `Unable to load Agent package ${metadata.packageName}`,
        agentId,
        metadata.packageName,
        metadata.packageName,
        { cause: error },
      );
    }
    if (!packageModule.agentBlueprint || typeof packageModule.agentBlueprint !== "object") {
      throw new AgentPackageCatalogError(
        "agent_blueprint_missing",
        `Agent package ${metadata.packageName} does not export agentBlueprint`,
        agentId,
        metadata.packageName,
        metadata.packageName,
      );
    }
    return {
      packageName: metadata.packageName,
      packageVersion: metadata.packageVersion,
      manifest,
      blueprint: toAgentBlueprint(packageModule.agentBlueprint, agentId, metadata.packageName),
    };
  }

  private async resolveMetadata(
    agentId: string,
    registration?: AgentPackageRegistration,
  ): Promise<ResolvedPackageMetadata> {
    const packageName = packageNameFor(agentId);
    if (registration?.bundledManifest !== undefined) {
      const packageVersion = registration.bundledPackageVersion;
      if (packageVersion === undefined) {
        throw new AgentPackageCatalogError(
          "agent_package_incompatible",
          `Bundled Agent registration is missing its package version: ${agentId}`,
          agentId,
          packageName,
          `builtin:${packageName}/agent.yaml`,
        );
      }
      if (!validVersion(packageVersion)) {
        throw new AgentPackageCatalogError(
          "agent_package_incompatible",
          `Bundled package version is invalid: ${packageVersion}`,
          agentId,
          packageName,
          `builtin:${packageName}/agent.yaml`,
        );
      }
      return {
        packageName,
        packageVersion,
        manifestSource: `builtin:${packageName}/agent.yaml`,
        rawManifest: registration.bundledManifest,
      };
    }

    const bases = await normalizeResolutionBases(this.options.resolutionBases ?? []);
    let packageEntry: string | undefined;
    try {
      const require = resolveRequire(bases, packageName);
      packageEntry = require.resolve(packageName);
      const manifestSource = require.resolve(`${packageName}/agent.yaml`);
      const rawManifest = await readManifest(manifestSource, agentId, packageName);
      const packageMetadata = await findPackageMetadata(packageEntry);
      if (packageMetadata.name !== packageName || !validVersion(packageMetadata.version)) {
        throw new AgentPackageCatalogError(
          "agent_identity_mismatch",
          `Agent package metadata does not match ${packageName}`,
          agentId,
          packageName,
          packageMetadata.source,
        );
      }
      return {
        packageName,
        packageVersion: packageMetadata.version,
        manifestSource,
        rawManifest,
        packageEntry,
      };
    } catch (error) {
      if (error instanceof AgentPackageCatalogError) throw error;
      if (packageEntry !== undefined) {
        throw new AgentPackageCatalogError(
          "agent_package_incompatible",
          `Agent package ${packageName} does not export ./agent.yaml and is incompatible with the Manifest-first package API`,
          agentId,
          packageName,
          packageName,
          { cause: error },
        );
      }
      throw new AgentPackageCatalogError(
        registration ? "agent_manifest_not_found" : "agent_not_registered",
        `Unable to resolve Agent manifest for ${packageName}`,
        agentId,
        packageName,
        packageName,
        { cause: error },
      );
    }
  }
}

function parseManifest(metadata: ResolvedPackageMetadata, agentId: string) {
  let manifest;
  try {
    manifest = parseAgentManifest(metadata.rawManifest, metadata.manifestSource);
  } catch (error) {
    const incompatible =
      error instanceof Error && "code" in error && error.code === "agent_package_incompatible";
    throw new AgentPackageCatalogError(
      incompatible ? "agent_package_incompatible" : "agent_manifest_invalid",
      error instanceof Error ? error.message : String(error),
      agentId,
      metadata.packageName,
      metadata.manifestSource,
      { cause: error },
    );
  }
  if (manifest.metadata.id !== agentId) {
    throw new AgentPackageCatalogError(
      "agent_identity_mismatch",
      `Agent manifest id mismatch: expected ${agentId}, received ${manifest.metadata.id}`,
      agentId,
      metadata.packageName,
      metadata.manifestSource,
    );
  }
  return manifest;
}

async function normalizeResolutionBases(values: readonly string[]): Promise<readonly string[]> {
  const bases: string[] = [];
  for (const value of values) {
    const normalized = resolve(value);
    bases.push(normalized);
    try {
      const physical = await realpath(normalized);
      if (physical !== normalized) bases.push(physical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...new Set(bases)];
}

function resolveRequire(bases: readonly string[], packageName: string): NodeJS.Require {
  let lastError: unknown;
  for (const base of bases) {
    const require = createRequire(base);
    try {
      require.resolve(packageName);
      return require;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`No resolution base can load ${packageName}`);
}

async function readManifest(path: string, agentId: string, packageName: string): Promise<string> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new AgentPackageCatalogError(
      "agent_manifest_not_found",
      `Agent manifest not found: ${path}`,
      agentId,
      packageName,
      path,
      { cause: error },
    );
  }
  if (!metadata.isFile() || metadata.size > MAX_AGENT_MANIFEST_BYTES) {
    throw new AgentPackageCatalogError(
      "agent_manifest_invalid",
      !metadata.isFile()
        ? `Agent manifest is not a regular file: ${path}`
        : `Agent manifest exceeds ${MAX_AGENT_MANIFEST_BYTES} bytes: ${path}`,
      agentId,
      packageName,
      path,
    );
  }
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new AgentPackageCatalogError(
      "agent_package_load_failed",
      `Unable to read Agent manifest: ${path}`,
      agentId,
      packageName,
      path,
      { cause: error },
    );
  }
}

async function findPackageMetadata(
  entry: string,
): Promise<{ name: string; version: string; source: string }> {
  let directory = dirname(entry);
  while (true) {
    const source = resolve(directory, "package.json");
    try {
      const value = JSON.parse(await readFile(source, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof value.name === "string" && typeof value.version === "string") {
        return { name: value.name, version: value.version, source };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Package metadata not found for ${entry}`);
    directory = parent;
  }
}

function toAgentBlueprint(value: object, agentId: string, packageName: string): AgentBlueprint {
  const blueprint = value as AgentBlueprint;
  if (typeof blueprint.build !== "function") {
    throw new AgentPackageCatalogError(
      "agent_blueprint_invalid",
      `Agent Blueprint build must be a function: ${packageName}`,
      agentId,
      packageName,
      packageName,
    );
  }
  try {
    const descriptor = validateAgentBlueprintDescriptor(blueprint.descriptor);
    return { descriptor, build: (context) => blueprint.build(context) };
  } catch (error) {
    throw new AgentPackageCatalogError(
      "agent_blueprint_invalid",
      `Agent Blueprint descriptor is invalid: ${error instanceof Error ? error.message : String(error)}`,
      agentId,
      packageName,
      packageName,
      { cause: error },
    );
  }
}

function packageNameFor(agentId: string): string {
  return `@omni-agent/agent-${agentId}`;
}

function assertAgentId(agentId: string): void {
  if (!isAgentId(agentId)) {
    const packageName = packageNameFor(agentId);
    throw new AgentPackageCatalogError(
      "agent_not_registered",
      `Invalid Agent id: ${agentId}`,
      agentId,
      packageName,
      packageName,
    );
  }
}

function validVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}
