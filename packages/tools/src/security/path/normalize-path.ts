import fs from "node:fs/promises";
import path from "node:path";

export function resolveToolPath(value: string, cwd: string): string {
  return path.resolve(cwd, value);
}

export async function canonicalizeToolPath(value: string, cwd: string): Promise<string> {
  const resolved = resolveToolPath(value, cwd);
  let cursor = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = await fs.realpath(cursor);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
