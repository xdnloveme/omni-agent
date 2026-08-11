import fs from "node:fs/promises";
import path from "node:path";
import { throwIfAborted } from "@omni-agent/core";

const STAT_CONCURRENCY = 16;

export async function loadFileSizes(
  paths: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, number | null>> {
  const uniquePaths = [...new Set(paths)];
  const sizes = new Map<string, number | null>();
  for (let start = 0; start < uniquePaths.length; start += STAT_CONCURRENCY) {
    throwIfAborted(signal);
    const batch = uniquePaths.slice(start, start + STAT_CONCURRENCY);
    const values = await Promise.all(batch.map((value) => readFileSize(value, cwd)));
    batch.forEach((value, index) => sizes.set(value, values[index]));
  }
  throwIfAborted(signal);
  return sizes;
}

async function readFileSize(value: string, cwd: string): Promise<number | null> {
  try {
    const stats = await fs.stat(path.resolve(cwd, value));
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

export function formatFileSize(sizeBytes: number | null): string {
  if (sizeBytes === null) return "size unavailable";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = sizeBytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(1)} ${unit}`;
}
