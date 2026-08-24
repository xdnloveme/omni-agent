import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SandboxPathScope } from "@omni-agent/core";
import { SandboxProcessError } from "../../../sandbox-process-error";
import type { PlatformRuntimeDependencyResolver } from "../platform-runtime-dependency-resolver";
import type { PlatformDependencyContext } from "../../types";
import { VersionedFileComputationCache } from "../../../versioned-file-computation-cache";
import { inspectMachO } from "./otool-adapter";
import type { DarwinDeveloperToolRuntimeResolver } from "./developer-tool-runtime-resolver";

const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf,
]);

type MachOInspector = typeof inspectMachO;

interface DarwinMachOResolverOptions {
  readonly inspect?: MachOInspector;
  readonly developerTools?: DarwinDeveloperToolRuntimeResolver;
}

export class DarwinMachODependencyResolver implements PlatformRuntimeDependencyResolver {
  private readonly inspections = new VersionedFileComputationCache<
    Awaited<ReturnType<MachOInspector>>
  >();

  private readonly inspect: MachOInspector;
  private readonly developerTools: DarwinDeveloperToolRuntimeResolver | undefined;

  constructor(options: DarwinMachOResolverOptions = {}) {
    this.inspect = options.inspect ?? inspectMachO;
    this.developerTools = options.developerTools;
  }

  supports(_path: string, header: Uint8Array): boolean {
    if (header.byteLength < 4) return false;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    return MACHO_MAGICS.has(view.getUint32(0, false)) || MACHO_MAGICS.has(view.getUint32(0, true));
  }

  async resolve(
    executablePath: string,
    context: PlatformDependencyContext,
  ): Promise<readonly SandboxPathScope[]> {
    const pending: Array<{ imagePath: string; inheritedRpaths: readonly string[] }> = [
      { imagePath: executablePath, inheritedRpaths: [] },
    ];
    const visited = new Set<string>();
    const resolved: SandboxPathScope[] = [];
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (visited.has(current.imagePath)) continue;
      context.consumeImageBudget(current.imagePath);
      visited.add(current.imagePath);
      const inspection = await this.inspections.get(current.imagePath, context.signal, (signal) =>
        this.inspect(current.imagePath, signal),
      );
      if (current.imagePath === executablePath && this.developerTools) {
        resolved.push(...(await this.developerTools.resolve(inspection, context.signal)));
      }
      const localRpaths = inspection.rpaths
        .map((rpath) => expandRpath(rpath, current.imagePath, context.rootExecutablePath))
        .filter((rpath): rpath is string => Boolean(rpath));
      const effectiveRpaths = [...new Set([...localRpaths, ...current.inheritedRpaths])];
      for (const dependency of inspection.dependencies) {
        const candidates = await resolveDependency(
          dependency,
          current.imagePath,
          context.rootExecutablePath,
          effectiveRpaths,
        );
        if (candidates.length === 0 && (dependency.startsWith("@") || !isSystemImage(dependency))) {
          throw new SandboxProcessError(
            "sandbox_runtime_dependency_unresolved",
            "Unable to resolve a Mach-O runtime dependency.",
          );
        }
        resolved.push(
          ...candidates.map((candidate) => ({ path: candidate, scope: "exact" as const })),
        );
        const canonical = candidates.at(-1);
        if (canonical && !isSystemImage(canonical)) {
          pending.push({ imagePath: canonical, inheritedRpaths: effectiveRpaths });
        }
      }
    }
    return [...new Map(resolved.map((scope) => [`${scope.scope}\0${scope.path}`, scope])).values()];
  }
}

async function resolveDependency(
  dependency: string,
  imagePath: string,
  rootExecutablePath: string,
  rpaths: readonly string[],
): Promise<readonly string[]> {
  if (path.isAbsolute(dependency)) return lexicalAndCanonicalIfPresent(dependency);
  if (dependency.startsWith("@loader_path/")) {
    return lexicalAndCanonicalIfPresent(path.join(path.dirname(imagePath), dependency.slice(13)));
  }
  if (dependency.startsWith("@executable_path/")) {
    return lexicalAndCanonicalIfPresent(
      path.join(path.dirname(rootExecutablePath), dependency.slice(17)),
    );
  }
  if (dependency.startsWith("@rpath/")) {
    const suffix = dependency.slice(7);
    for (const rpath of rpaths) {
      const candidates = await lexicalAndCanonicalIfPresent(path.join(rpath, suffix));
      if (candidates.length > 0) return candidates;
    }
  }
  return [];
}

function expandRpath(
  rpath: string,
  imagePath: string,
  rootExecutablePath: string,
): string | undefined {
  if (path.isAbsolute(rpath)) return rpath;
  if (rpath.startsWith("@loader_path/")) return path.join(path.dirname(imagePath), rpath.slice(13));
  if (rpath.startsWith("@executable_path/")) {
    return path.join(path.dirname(rootExecutablePath), rpath.slice(17));
  }
  return undefined;
}

function isSystemImage(candidate: string): boolean {
  return candidate.startsWith("/System/") || candidate.startsWith("/usr/lib/");
}

async function lexicalAndCanonicalIfPresent(candidate: string): Promise<readonly string[]> {
  try {
    const lexical = path.normalize(candidate);
    const canonical = await realpath(lexical);
    return lexical === canonical ? [canonical] : [lexical, canonical];
  } catch {
    return [];
  }
}
