import { open } from "node:fs/promises";
import path from "node:path";
import {
  isAbortError,
  throwIfAborted,
  type ProcessExecutableRequirement,
  type SandboxPathScope,
} from "@omni-agent/core";
import { SandboxProcessError } from "../sandbox-process-error";
import { isWithinPath } from "../../security/path/path-boundary";
import { inferExecutableRuntimeScopes } from "./runtime-root-inference";
import { readShebang } from "./shebang-resolver";
import { discoverShellScriptRequirements } from "./shell-script-runtime-requirements";
import type { PlatformRuntimeDependencyResolver } from "./platform/platform-runtime-dependency-resolver";
import { isSystemRuntimePath } from "./platform/system-runtime-paths";
import { resolveTrustedExecutable } from "./trusted-executable-resolver";
import type {
  ExecutableRequirement,
  ExecutableRuntimeProjection,
  HostRuntimeSnapshot,
  ResolvedExecutable,
  RuntimeProjectionContext,
} from "./types";
import { toExecutableRequirement } from "./types";
import { VersionedFileComputationCache } from "../versioned-file-computation-cache";

const MAX_REQUIREMENTS = 128;
const MAX_EXECUTABLES = 128;
const MAX_READ_SCOPES = 64;
const MAX_INTERPRETER_DEPTH = 8;
const MAX_NATIVE_IMAGES = 128;
const HEADER_BYTES = 16;

export class ExecutableRuntimeProjectionResolver {
  private readonly fileInspection = new VersionedFileComputationCache<ExecutableFileInspection>();

  constructor(
    private readonly snapshot: HostRuntimeSnapshot,
    private readonly platformResolvers: readonly PlatformRuntimeDependencyResolver[],
  ) {}

  async resolve(
    primaryCommand: string,
    requirements: readonly ProcessExecutableRequirement[],
    context: RuntimeProjectionContext,
  ): Promise<ExecutableRuntimeProjection> {
    try {
      return await this.resolveProjection(primaryCommand, requirements, context);
    } catch (error) {
      if (isAbortError(error) || error instanceof SandboxProcessError) throw error;
      throw new SandboxProcessError(
        "sandbox_runtime_projection_failed",
        "Unable to construct the executable runtime projection.",
      );
    }
  }

  private async resolveProjection(
    primaryCommand: string,
    requirements: readonly ProcessExecutableRequirement[],
    context: RuntimeProjectionContext,
  ): Promise<ExecutableRuntimeProjection> {
    if (requirements.length > MAX_REQUIREMENTS) throw projectionLimit();
    const state: ProjectionState = {
      scopes: new Map(),
      executablePaths: new Set(),
      nativeImagePaths: new Set(),
      interpreterStack: new Set(),
    };
    const primaryRequirement: ExecutableRequirement = {
      command: primaryCommand,
      cwd: context.cwd,
      origin: "primary",
    };
    const primary = await resolveTrustedExecutable(
      primaryRequirement,
      this.snapshot,
      context.policy,
      context.signal,
    );
    await this.projectExecutable(primary, context, state, 0);
    for (const requirement of requirements) {
      throwIfAborted(context.signal);
      const executableRequirement = toExecutableRequirement(requirement);
      if (!executableRequirement) {
        throw new SandboxProcessError(
          "sandbox_runtime_projection_failed",
          "A shell executable has an unknown effective working directory.",
        );
      }
      const executable = await resolveTrustedExecutable(
        executableRequirement,
        this.snapshot,
        context.policy,
        context.signal,
      );
      await this.projectExecutable(executable, context, state, 0);
    }
    const readScopes = minimizeScopes(
      [...state.scopes.values()].filter(
        (scope) => !isAlreadyReadable(scope.path, context, this.snapshot.platform),
      ),
      this.snapshot.platform,
    );
    if (readScopes.length > MAX_READ_SCOPES) throw projectionLimit();
    return {
      executablePath: primary.executablePath,
      canonicalExecutablePath: primary.canonicalExecutablePath,
      readScopes,
    };
  }

  private async projectExecutable(
    executable: ResolvedExecutable,
    context: RuntimeProjectionContext,
    state: ProjectionState,
    depth: number,
  ): Promise<void> {
    throwIfAborted(context.signal);
    if (depth > MAX_INTERPRETER_DEPTH) throw projectionLimit();
    if (state.interpreterStack.has(executable.canonicalExecutablePath)) {
      throw new SandboxProcessError(
        "sandbox_runtime_dependency_unresolved",
        "Executable interpreter chain contains a cycle.",
      );
    }
    if (state.executablePaths.has(executable.canonicalExecutablePath)) return;
    if (state.executablePaths.size >= MAX_EXECUTABLES) {
      throw projectionLimit();
    }
    state.executablePaths.add(executable.canonicalExecutablePath);

    const inspection = await this.fileInspection.get(
      executable.canonicalExecutablePath,
      context.signal,
      async (signal) => {
        throwIfAborted(signal);
        const [shebang, header] = await Promise.all([
          readShebang(executable.canonicalExecutablePath),
          readHeader(executable.canonicalExecutablePath),
        ]);
        const scriptRequirements = shebang
          ? await discoverShellScriptRequirements(
              executable.canonicalExecutablePath,
              shebang.interpreter,
              this.snapshot,
              signal,
            )
          : [];
        throwIfAborted(signal);
        return { shebang, header, scriptRequirements };
      },
    );
    const { shebang } = inspection;
    const executableScopes = await inferExecutableRuntimeScopes(
      executable,
      this.snapshot,
      shebang !== undefined,
      context.signal,
    );
    addScopes(state, executableScopes);
    if (shebang) {
      state.interpreterStack.add(executable.canonicalExecutablePath);
      try {
        for (const requirement of inspection.scriptRequirements) {
          const dependency = await this.resolveScriptDependency(
            requirement,
            executableScopes,
            context,
          );
          if (!dependency) continue;
          await this.projectExecutable(dependency, context, state, depth + 1);
        }
        const interpreter = await resolveTrustedExecutable(
          {
            command: shebang.interpreter,
            cwd: context.cwd,
            origin: "interpreter",
            parentRuntimeScopes: executableScopes,
          },
          this.snapshot,
          context.policy,
          context.signal,
        );
        await this.projectExecutable(interpreter, context, state, depth + 1);
      } finally {
        state.interpreterStack.delete(executable.canonicalExecutablePath);
      }
      return;
    }
    await this.projectNativeImage(
      executable.canonicalExecutablePath,
      inspection.header,
      context,
      state,
    );
  }

  private async resolveScriptDependency(
    requirement: { readonly command: string; readonly cwd: string },
    parentRuntimeScopes: readonly SandboxPathScope[],
    context: RuntimeProjectionContext,
  ): Promise<ResolvedExecutable | undefined> {
    try {
      return await resolveTrustedExecutable(
        { ...requirement, origin: "script_dependency", parentRuntimeScopes },
        this.snapshot,
        context.policy,
        context.signal,
      );
    } catch (error) {
      if (error instanceof SandboxProcessError && error.code === "process_executable_not_found") {
        return undefined;
      }
      throw error;
    }
  }

  private async projectNativeImage(
    imagePath: string,
    header: Uint8Array,
    context: RuntimeProjectionContext,
    state: ProjectionState,
  ): Promise<void> {
    const resolver = this.platformResolvers.find((candidate) =>
      candidate.supports(imagePath, header),
    );
    if (!resolver) return;
    const dependencies = await resolver.resolve(imagePath, {
      rootExecutablePath: imagePath,
      signal: context.signal,
      consumeImageBudget: (dependencyPath) => {
        if (state.nativeImagePaths.has(dependencyPath)) return;
        if (state.nativeImagePaths.size >= MAX_NATIVE_IMAGES) throw projectionLimit();
        state.nativeImagePaths.add(dependencyPath);
      },
    });
    for (const dependency of dependencies) {
      addScopes(state, [{ path: dependency, scope: "exact" }]);
    }
  }
}

interface ProjectionState {
  readonly scopes: Map<string, SandboxPathScope>;
  readonly executablePaths: Set<string>;
  readonly nativeImagePaths: Set<string>;
  readonly interpreterStack: Set<string>;
}

interface ExecutableFileInspection {
  readonly shebang: Awaited<ReturnType<typeof readShebang>>;
  readonly header: Uint8Array;
  readonly scriptRequirements: Awaited<ReturnType<typeof discoverShellScriptRequirements>>;
}

async function readHeader(pathname: string): Promise<Uint8Array> {
  const handle = await open(pathname, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function addScopes(state: ProjectionState, scopes: readonly SandboxPathScope[]): void {
  for (const scope of scopes) {
    state.scopes.set(`${scope.scope}\0${path.normalize(scope.path)}`, {
      ...scope,
      path: path.normalize(scope.path),
    });
  }
}

function isAlreadyReadable(
  candidate: string,
  context: RuntimeProjectionContext,
  platform: NodeJS.Platform,
): boolean {
  if (isSystemRuntimePath(candidate, platform)) return true;
  if (isWithinPath(candidate, context.policy.workspaceRoot, platform)) return true;
  return context.policy.read.some((scope) =>
    scope.scope === "exact"
      ? path.normalize(scope.path) === path.normalize(candidate)
      : isWithinPath(candidate, scope.path, platform),
  );
}

function minimizeScopes(
  scopes: readonly SandboxPathScope[],
  platform: NodeJS.Platform,
): readonly SandboxPathScope[] {
  const unique = [
    ...new Map(scopes.map((scope) => [`${scope.scope}\0${scope.path}`, scope])).values(),
  ];
  return unique
    .filter(
      (candidate) =>
        !unique.some(
          (covering) =>
            covering !== candidate &&
            covering.scope === "subtree" &&
            isWithinPath(candidate.path, covering.path, platform),
        ),
    )
    .sort((left, right) =>
      `${left.scope}\0${left.path}`.localeCompare(`${right.scope}\0${right.path}`),
    );
}

function projectionLimit(): SandboxProcessError {
  return new SandboxProcessError(
    "sandbox_runtime_projection_limit",
    "Executable runtime projection exceeds its bounded complexity limit.",
  );
}
