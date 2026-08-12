import { randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LockMetadata {
  pid: number;
  owner: string;
  createdAt: number;
}

export interface InterprocessFileLockOptions {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
}

export class InterprocessFileLock {
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly staleMs: number;
  private readonly metadataPath: string;
  private readonly reclaimPath: string;

  constructor(
    readonly path: string,
    options: InterprocessFileLockOptions = {},
  ) {
    this.retryMs = options.retryMs ?? 50;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.staleMs = options.staleMs ?? 30_000;
    this.metadataPath = join(path, "owner.json");
    this.reclaimPath = join(path, "reclaim");
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const owner = await this.acquire();
    try {
      return await operation();
    } finally {
      await this.release(owner);
    }
  }

  private async acquire(): Promise<string> {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      const owner = randomUUID();
      try {
        await mkdir(this.path, { mode: 0o700 });
        try {
          await writeFile(
            this.metadataPath,
            JSON.stringify({ pid: process.pid, owner, createdAt: Date.now() }),
            { mode: 0o600, flag: "wx" },
          );
          return owner;
        } catch (error) {
          await unlink(this.metadataPath).catch(() => undefined);
          await rmdir(this.path).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.removeStale();
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for file lock: ${this.path}`);
        }
        await delay(this.retryMs);
      }
    }
  }

  private async release(owner: string): Promise<void> {
    await this.removeIfOwned(owner);
  }

  private async removeStale(): Promise<void> {
    const snapshot = await this.readMetadata();
    if (!snapshot) return;
    const createdAt =
      typeof snapshot.createdAt === "number" ? snapshot.createdAt : (await stat(this.path)).mtimeMs;
    if (Date.now() - createdAt < this.staleMs) return;
    if (
      typeof snapshot.pid !== "number" ||
      typeof snapshot.owner !== "string" ||
      !snapshot.owner ||
      isProcessAlive(snapshot.pid)
    ) {
      return;
    }
    await this.reclaim(snapshot.pid, snapshot.owner);
  }

  private async reclaim(pid: number, owner: string): Promise<void> {
    try {
      await writeFile(this.reclaimPath, randomUUID(), { mode: 0o600, flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || isRemovedDirectoryRace(code)) return;
      throw error;
    }

    try {
      const current = await this.readMetadata();
      if (current?.pid !== pid || current.owner !== owner || isProcessAlive(pid)) return;
      await unlink(this.metadataPath);
      await unlink(this.reclaimPath);
      await rmdir(this.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    } finally {
      await unlink(this.reclaimPath).catch((error: NodeJS.ErrnoException) => {
        if (!isRemovedDirectoryRace(error.code)) throw error;
      });
    }
  }

  private async removeIfOwned(owner: string): Promise<void> {
    const current = await this.readMetadata();
    if (!current || current.owner !== owner) return;
    await unlink(this.metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }

  private async readMetadata(): Promise<Partial<LockMetadata> | undefined> {
    try {
      return JSON.parse(await readFile(this.metadataPath, "utf8")) as Partial<LockMetadata>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          const directory = await stat(this.path);
          return { owner: "", createdAt: directory.mtimeMs };
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw statError;
        }
      }
      if (error instanceof SyntaxError) {
        const file = await stat(this.metadataPath);
        return { owner: "", createdAt: file.mtimeMs };
      }
      throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRemovedDirectoryRace(code: string | undefined): boolean {
  // macOS may report EINVAL when another contender removes the parent during open/unlink.
  return code === "ENOENT" || code === "EINVAL";
}
