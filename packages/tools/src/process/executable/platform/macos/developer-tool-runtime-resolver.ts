import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { throwIfAborted, type SandboxPathScope } from "@omni-agent/core";
import { SandboxProcessError } from "../../../sandbox-process-error";
import type { HostRuntimeSnapshot } from "../../types";
import type { MachOInspection } from "./otool-adapter";

const XCRUN_SHIM_SECTION = "__DATA,__xcrun_shim";
const XCSELECT_LIBRARY = "/usr/lib/libxcselect.dylib";
const XCODE_LICENSE_PREFERENCES = "/Library/Preferences/com.apple.dt.Xcode.plist";

interface DeveloperSelectionPaths {
  readonly lexical: string;
  readonly canonical: string;
}

const DEFAULT_SELECTION_PATHS: DeveloperSelectionPaths = {
  lexical: "/var/select/developer_dir",
  canonical: "/private/var/select/developer_dir",
};

/** Resolves the active Xcode/CommandLineTools root only for Apple developer-tool shims. */
export class DarwinDeveloperToolRuntimeResolver {
  constructor(
    private readonly snapshot: HostRuntimeSnapshot,
    private readonly selectionPaths: DeveloperSelectionPaths = DEFAULT_SELECTION_PATHS,
  ) {}

  async resolve(
    inspection: MachOInspection,
    signal?: AbortSignal,
  ): Promise<readonly SandboxPathScope[]> {
    if (!isDeveloperToolShim(inspection)) return [];
    throwIfAborted(signal);
    const configuredPath = this.snapshot.developerDirectory ?? this.selectionPaths.lexical;
    if (!path.isAbsolute(configuredPath)) throw unresolvedDeveloperDirectory();
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(configuredPath);
      const metadata = await stat(canonicalRoot);
      if (!metadata.isDirectory()) throw unresolvedDeveloperDirectory();
    } catch (error) {
      if (error instanceof SandboxProcessError) throw error;
      throw unresolvedDeveloperDirectory();
    }
    throwIfAborted(signal);
    const runtimeRoot = await inferDeveloperRuntimeRoot(canonicalRoot);
    throwIfAborted(signal);
    assertBoundedRoot(runtimeRoot, this.snapshot);
    const roots = new Set([path.normalize(runtimeRoot)]);
    if (this.snapshot.developerDirectory) roots.add(path.normalize(configuredPath));
    const selectorScopes: SandboxPathScope[] = this.snapshot.developerDirectory
      ? []
      : [
          { path: path.dirname(path.normalize(this.selectionPaths.lexical)), scope: "subtree" },
          { path: path.dirname(path.normalize(this.selectionPaths.canonical)), scope: "subtree" },
        ];
    return [
      ...selectorScopes,
      { path: XCODE_LICENSE_PREFERENCES, scope: "exact" },
      ...[...roots].map((root) => ({ path: root, scope: "subtree" as const })),
    ];
  }
}

async function inferDeveloperRuntimeRoot(developerDirectory: string): Promise<string> {
  const bundleContents = path.dirname(developerDirectory);
  try {
    const metadata = await stat(path.join(bundleContents, "Info.plist"));
    if (metadata.isFile()) return bundleContents;
  } catch {
    // CommandLineTools installations use the developer directory itself as their runtime root.
  }
  return developerDirectory;
}

function isDeveloperToolShim(inspection: MachOInspection): boolean {
  return (
    inspection.sections.includes(XCRUN_SHIM_SECTION) ||
    inspection.dependencies.includes(XCSELECT_LIBRARY)
  );
}

function assertBoundedRoot(candidate: string, snapshot: HostRuntimeSnapshot): void {
  const normalized = path.resolve(candidate);
  const filesystemRoot = path.parse(normalized).root;
  if (
    normalized === filesystemRoot ||
    path.dirname(normalized) === filesystemRoot ||
    normalized === snapshot.home ||
    normalized === path.join(snapshot.home, "Library")
  ) {
    throw new SandboxProcessError(
      "sandbox_runtime_projection_too_broad",
      "The active developer-tool runtime root cannot be bounded safely.",
    );
  }
}

function unresolvedDeveloperDirectory(): SandboxProcessError {
  return new SandboxProcessError(
    "sandbox_runtime_dependency_unresolved",
    "Unable to resolve the active macOS developer-tool runtime.",
  );
}
