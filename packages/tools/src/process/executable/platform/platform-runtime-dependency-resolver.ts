import type { PlatformDependencyContext } from "../types";

export interface PlatformRuntimeDependencyResolver {
  supports(path: string, header: Uint8Array): boolean;
  resolve(executablePath: string, context: PlatformDependencyContext): Promise<readonly string[]>;
}
