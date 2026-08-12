import fs from "node:fs/promises";
import path from "node:path";

export type CanonicalPathKind =
  "regular_file" | "directory" | "special" | "missing" | "dangling_symlink";

export interface CanonicalPathResolution {
  target: string;
  targetKind: CanonicalPathKind;
}

export function resolveToolPath(value: string, cwd: string): string {
  return path.resolve(cwd, value);
}

export async function canonicalizeToolPath(value: string, cwd: string): Promise<string> {
  return (await resolveCanonicalPath(value, cwd)).target;
}

export async function resolveCanonicalPath(
  value: string,
  cwd: string,
): Promise<CanonicalPathResolution> {
  const resolved = resolveToolPath(value, cwd);
  try {
    const linkStats = await fs.lstat(resolved);
    if (linkStats.isSymbolicLink()) {
      try {
        const target = await fs.realpath(resolved);
        return { target, targetKind: classifyStats(await fs.stat(target)) };
      } catch (error) {
        if (isMissing(error)) return { target: resolved, targetKind: "dangling_symlink" };
        throw error;
      }
    }
    return { target: await fs.realpath(resolved), targetKind: classifyStats(linkStats) };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let cursor = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = await fs.realpath(cursor);
      return { target: path.join(canonical, ...suffix.reverse()), targetKind: "missing" };
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        const stats = await fs.lstat(cursor);
        if (stats.isSymbolicLink()) {
          return { target: resolved, targetKind: "dangling_symlink" };
        }
      } catch (lstatError) {
        if (!isMissing(lstatError)) throw lstatError;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return { target: resolved, targetKind: "missing" };
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function normalizeForComparison(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = path.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function classifyStats(stats: Awaited<ReturnType<typeof fs.stat>>): CanonicalPathKind {
  if (stats.isFile()) return "regular_file";
  if (stats.isDirectory()) return "directory";
  return "special";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
