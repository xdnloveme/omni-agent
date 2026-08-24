import type {
  ProcessExecutableRequirement,
  SandboxPathScope,
  SandboxPolicy,
} from "@omni-agent/core";

export interface HostRuntimeEnvironment {
  readonly platform: NodeJS.Platform;
  readonly path: string;
  readonly pathExt?: string;
  readonly home: string;
}

export type HostPathEntry =
  | { readonly kind: "absolute"; readonly path: string }
  | { readonly kind: "cwd"; readonly path: string };

export interface HostRuntimeSnapshot {
  readonly platform: NodeJS.Platform;
  readonly path: string;
  readonly pathEntries: readonly HostPathEntry[];
  readonly pathExtensions: readonly string[];
  readonly home: string;
}

export interface ResolvedExecutable {
  readonly executablePath: string;
  readonly canonicalExecutablePath: string;
  readonly pathEntry?: string;
  readonly lookupSource: "explicit_path" | "immutable_path" | "relative_path";
}

export type ExecutableRequirement =
  | {
      readonly command: string;
      readonly cwd: string;
      readonly origin: "primary" | "shell_command";
    }
  | {
      readonly command: string;
      readonly cwd: string;
      readonly origin: "script_dependency" | "interpreter";
      readonly parentRuntimeScopes: readonly SandboxPathScope[];
    };

export interface ExecutableRuntimeProjection {
  readonly executablePath: string;
  readonly canonicalExecutablePath: string;
  readonly readScopes: readonly SandboxPathScope[];
}

export interface RuntimeProjectionContext {
  readonly cwd: string;
  readonly policy: SandboxPolicy;
  readonly signal?: AbortSignal;
}

export function toExecutableRequirement(
  requirement: ProcessExecutableRequirement,
): ExecutableRequirement | undefined {
  if (requirement.cwd === "unknown") return undefined;
  return {
    command: requirement.command,
    cwd: requirement.cwd,
    origin: "shell_command",
  };
}

export interface PlatformDependencyContext {
  readonly rootExecutablePath: string;
  readonly signal?: AbortSignal;
  consumeImageBudget(imagePath: string): void;
}
