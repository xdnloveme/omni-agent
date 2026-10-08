import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectInstructionManifest } from "./manifest";

const FILE_NAME = "AGENTS.md";

export class ProjectInstructionDiscovery {
  private constructor(readonly workspaceRoot: string) {}

  static async create(workspaceRoot: string): Promise<ProjectInstructionDiscovery> {
    return new ProjectInstructionDiscovery(await realpath(workspaceRoot));
  }

  async discoverForTarget(target: string): Promise<readonly ProjectInstructionManifest[]> {
    const directory = await this.targetDirectory(target);
    if (!isWithin(this.workspaceRoot, directory)) return [];
    const manifests: ProjectInstructionManifest[] = [];
    const lineage: string[] = [];
    for (const scope of lineageDirectories(this.workspaceRoot, directory)) {
      const file = path.join(scope, FILE_NAME);
      const manifest = await readStableManifest(file, scope, [...lineage, file]);
      if (!manifest) continue;
      lineage.push(file);
      manifests.push(manifest);
    }
    return manifests;
  }

  private async targetDirectory(target: string): Promise<string> {
    let cursor = path.resolve(this.workspaceRoot, target);
    for (;;) {
      try {
        const info = await stat(cursor);
        const canonical = await realpath(cursor);
        return info.isDirectory() ? canonical : path.dirname(canonical);
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) return cursor;
        cursor = parent;
      }
    }
  }
}

async function readStableManifest(
  file: string,
  appliesTo: string,
  lineage: readonly string[],
): Promise<ProjectInstructionManifest | undefined> {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw Object.assign(new Error(`Project instruction file must be a regular file: ${file}`), {
      code: "project_instruction_invalid_file",
    });
  }
  const content = await readFile(file, "utf8");
  const after = await lstat(file);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size
  ) {
    throw Object.assign(new Error(`Project instruction file changed while loading: ${file}`), {
      code: "project_instruction_changed_during_load",
    });
  }
  return {
    path: file,
    appliesTo,
    lineage,
    digest: createHash("sha256").update(content).digest("hex"),
    identity: { device: after.dev, inode: after.ino, mtimeMs: after.mtimeMs, size: after.size },
    content,
  };
}

function lineageDirectories(root: string, target: string): readonly string[] {
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  const result = [root];
  for (const part of parts) result.push(path.join(result.at(-1)!, part));
  return result;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
