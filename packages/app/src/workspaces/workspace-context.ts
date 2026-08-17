import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

const WORKSPACE_ID_NAMESPACE = "omni-workspace:v1\0";

export interface WorkspaceContext {
  readonly id: string;
  readonly root: string;
}

export async function resolveWorkspaceContext(startDirectory: string): Promise<WorkspaceContext> {
  const canonicalStart = normalizeWorkspaceRoot(await realpath(startDirectory));
  const root = await findWorkspaceRoot(canonicalStart);
  return { id: createWorkspaceId(root), root };
}

export function createWorkspaceId(canonicalWorkspaceRoot: string): string {
  return createHash("sha256")
    .update(`${WORKSPACE_ID_NAMESPACE}${canonicalWorkspaceRoot}`)
    .digest("hex");
}

export function normalizeWorkspaceRoot(
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = canonicalPath.replaceAll("\\", "/");
  if (platform !== "win32") return normalized;
  return normalized.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}

async function findWorkspaceRoot(startDirectory: string): Promise<string> {
  let current = startDirectory;
  while (true) {
    if (await pathExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return startDirectory;
    current = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
