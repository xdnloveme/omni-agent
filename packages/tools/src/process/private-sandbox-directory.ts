import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withPrivateSandboxDirectory<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const created = await mkdtemp(path.join(os.tmpdir(), "omni-sandbox-"));
  try {
    const directory = await realpath(created);
    await chmod(directory, 0o700);
    return await operation(directory);
  } finally {
    await rm(created, { recursive: true, force: true }).catch(() => undefined);
  }
}
