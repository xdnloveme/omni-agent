import { DarwinMachODependencyResolver } from "./macos/macho-dependency-resolver";
import type { PlatformRuntimeDependencyResolver } from "./platform-runtime-dependency-resolver";

export interface ProcessPlatformRuntime {
  readonly sandboxSupported: boolean;
  readonly dependencyResolvers: readonly PlatformRuntimeDependencyResolver[];
}

export function createProcessPlatformRuntime(platform: NodeJS.Platform): ProcessPlatformRuntime {
  if (platform === "darwin") {
    return {
      sandboxSupported: true,
      dependencyResolvers: [new DarwinMachODependencyResolver()],
    };
  }
  return { sandboxSupported: false, dependencyResolvers: [] };
}
