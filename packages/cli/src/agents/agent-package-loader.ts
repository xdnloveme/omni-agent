import { createRequire } from "node:module";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseAgentManifest,
  validateAgentBlueprintDescriptor,
  MAX_AGENT_MANIFEST_BYTES,
  type AgentBlueprint,
  type LoadedAgentPackage,
} from "@omni-agent/app";
import { isAgentId } from "@omni-agent/core";
import { loadBuiltinAgentPackage } from "./builtin-agent-loaders";

interface AgentPackageModule {
  readonly agentBlueprint?: unknown;
}

export interface AgentPackageLoaderOptions {
  readonly resolutionBase?: string;
  readonly agentPackagesDirectory?: string;
}

export class AgentPackageLoadError extends Error {
  constructor(
    readonly code:
      | "agent_manifest_not_found"
      | "agent_manifest_invalid"
      | "agent_package_incompatible"
      | "agent_identity_mismatch"
      | "agent_blueprint_missing"
      | "agent_blueprint_invalid"
      | "agent_package_load_failed",
    message: string,
    readonly agentId: string,
    readonly packageName: string,
    readonly source: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentPackageLoadError";
  }
}

export async function loadAgentPackage(
  agentId: string,
  options: AgentPackageLoaderOptions = {},
): Promise<LoadedAgentPackage> {
  if (!isAgentId(agentId)) throw new Error(`Invalid agent id: ${agentId}`);
  const packageName = `@omni-agent/agent-${agentId}`;
  const injectedManifest = builtinValue(
    typeof __OMNI_BUILTIN_AGENT_MANIFESTS__ === "undefined"
      ? undefined
      : __OMNI_BUILTIN_AGENT_MANIFESTS__,
    agentId,
  );
  const bases = await resolutionBases(options);
  let manifestSource: string;
  let rawManifest: string;
  let packageVersion: string;
  let packageEntry: string | undefined;

  try {
    if (injectedManifest !== undefined) {
      manifestSource = `builtin:${packageName}/agent.yaml`;
      rawManifest = injectedManifest;
      packageVersion =
        builtinValue(
          typeof __OMNI_BUILTIN_AGENT_PACKAGE_VERSIONS__ === "undefined"
            ? undefined
            : __OMNI_BUILTIN_AGENT_PACKAGE_VERSIONS__,
          agentId,
        ) ?? "";
      if (!validVersion(packageVersion)) {
        throw new AgentPackageLoadError(
          "agent_package_incompatible",
          `Bundled package version is invalid: ${packageVersion}`,
          agentId,
          packageName,
          manifestSource,
        );
      }
    } else {
      const require = resolveRequire(bases, packageName);
      packageEntry = require.resolve(packageName);
      manifestSource = require.resolve(`${packageName}/agent.yaml`);
      rawManifest = await readManifest(manifestSource, agentId, packageName);
      const metadata = await findPackageMetadata(packageEntry);
      if (metadata.name !== packageName || !validVersion(metadata.version)) {
        throw new AgentPackageLoadError(
          "agent_identity_mismatch",
          `Agent package metadata does not match ${packageName}`,
          agentId,
          packageName,
          metadata.source,
        );
      }
      packageVersion = metadata.version;
    }
  } catch (error) {
    if (error instanceof AgentPackageLoadError) throw error;
    if (packageEntry !== undefined) {
      throw new AgentPackageLoadError(
        "agent_package_incompatible",
        `Agent package ${packageName} does not export ./agent.yaml and is incompatible with the Manifest-first package API`,
        agentId,
        packageName,
        packageName,
        { cause: error },
      );
    }
    throw new AgentPackageLoadError(
      "agent_manifest_not_found",
      `Unable to resolve Agent manifest for ${packageName}`,
      agentId,
      packageName,
      packageName,
      { cause: error },
    );
  }

  let manifest;
  try {
    manifest = parseAgentManifest(rawManifest, manifestSource);
  } catch (error) {
    const incompatible =
      error instanceof Error && "code" in error && error.code === "agent_package_incompatible";
    throw new AgentPackageLoadError(
      incompatible ? "agent_package_incompatible" : "agent_manifest_invalid",
      error instanceof Error ? error.message : String(error),
      agentId,
      packageName,
      manifestSource,
      { cause: error },
    );
  }
  if (manifest.metadata.id !== agentId) {
    throw new AgentPackageLoadError(
      "agent_identity_mismatch",
      `Agent manifest id mismatch: expected ${agentId}, received ${manifest.metadata.id}`,
      agentId,
      packageName,
      manifestSource,
    );
  }

  let packageModule: AgentPackageModule;
  try {
    packageModule =
      (await loadBuiltinAgentPackage(agentId)) ??
      ((await import(
        pathToFileURL(packageEntry ?? resolveRequire(bases, packageName).resolve(packageName)).href
      )) as AgentPackageModule);
  } catch (error) {
    throw new AgentPackageLoadError(
      "agent_package_load_failed",
      `Unable to load Agent package ${packageName}`,
      agentId,
      packageName,
      packageName,
      { cause: error },
    );
  }
  if (!packageModule.agentBlueprint || typeof packageModule.agentBlueprint !== "object") {
    throw new AgentPackageLoadError(
      "agent_blueprint_missing",
      `Agent package ${packageName} does not export agentBlueprint`,
      agentId,
      packageName,
      packageName,
    );
  }
  const blueprint = toAgentBlueprint(packageModule.agentBlueprint, agentId, packageName);
  return {
    packageName,
    packageVersion,
    manifest,
    blueprint,
  };
}

function builtinValue(
  values: Readonly<Record<string, string>> | undefined,
  agentId: string,
): string | undefined {
  return typeof values === "object" && values ? values[agentId] : undefined;
}

async function resolutionBases(options: AgentPackageLoaderOptions): Promise<readonly string[]> {
  const logical = [
    options.resolutionBase,
    options.agentPackagesDirectory
      ? join(options.agentPackagesDirectory, "module-resolver.cjs")
      : undefined,
    import.meta.filename,
  ].filter((value): value is string => Boolean(value));
  const bases: string[] = [];
  for (const value of logical) {
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
  throw lastError;
}

async function readManifest(path: string, agentId: string, packageName: string): Promise<string> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new AgentPackageLoadError(
      "agent_manifest_not_found",
      `Agent manifest not found: ${path}`,
      agentId,
      packageName,
      path,
      { cause: error },
    );
  }
  if (!metadata.isFile() || metadata.size > MAX_AGENT_MANIFEST_BYTES) {
    throw new AgentPackageLoadError(
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
    throw new AgentPackageLoadError(
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
    const source = join(directory, "package.json");
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
    throw new AgentPackageLoadError(
      "agent_blueprint_invalid",
      `Agent Blueprint build must be a function: ${packageName}`,
      agentId,
      packageName,
      packageName,
    );
  }
  try {
    const descriptor = validateAgentBlueprintDescriptor(blueprint.descriptor);
    return {
      descriptor,
      build: (context) => blueprint.build(context),
    };
  } catch (error) {
    throw new AgentPackageLoadError(
      "agent_blueprint_invalid",
      `Agent Blueprint descriptor is invalid: ${error instanceof Error ? error.message : String(error)}`,
      agentId,
      packageName,
      packageName,
      { cause: error },
    );
  }
}

function validVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}
