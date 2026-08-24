import { DarwinMachODependencyResolver } from "./macos/macho-dependency-resolver";
import { DarwinDeveloperToolRuntimeResolver } from "./macos/developer-tool-runtime-resolver";
import type { PlatformRuntimeDependencyResolver } from "./platform-runtime-dependency-resolver";
import type { HostRuntimeSnapshot } from "../types";

export interface ProcessPlatformRuntime {
  readonly sandboxSupported: boolean;
  readonly dependencyResolvers: readonly PlatformRuntimeDependencyResolver[];
}

export function createProcessPlatformRuntime(
  snapshot: HostRuntimeSnapshot,
): ProcessPlatformRuntime {
  if (snapshot.platform === "darwin") {
    return {
      sandboxSupported: true,
      dependencyResolvers: [
        new DarwinMachODependencyResolver({
          developerTools: new DarwinDeveloperToolRuntimeResolver(snapshot),
        }),
      ],
    };
  }
  return { sandboxSupported: false, dependencyResolvers: [] };
}
