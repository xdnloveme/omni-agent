import { setTimeout as delay } from "node:timers/promises";
import { throwIfAborted } from "../execution/abort";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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

  async runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await operation();
    } finally {
      await this.release(owner);
    }
  }

  private async acquire(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    const owner = randomUUID();
    const candidate = await mkdtemp(`${this.path}.pending-`);
    const candidateMetadata = join(candidate, "owner.json");
    try {
      await writeFile(
        candidateMetadata,
        JSON.stringify({ pid: process.pid, owner, createdAt: Date.now() }),
        { mode: 0o600, flag: "wx" },
      );
      while (true) {
        throwIfAborted(signal);
        try {
          // Publish metadata and ownership together. An empty retired directory can be
          // replaced, but rename cannot replace a non-empty directory owned by a live call.
          await rename(candidate, this.path);
          return owner;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
          await this.removeStale();
          if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for file lock: ${this.path}`);
          }
          await delay(this.retryMs, undefined, { signal });
        }
      }
    } finally {
      await unlink(candidateMetadata).catch(ignoreMissing);
      await rmdir(candidate).catch(ignoreMissing);
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    } finally {
      await unlink(this.reclaimPath).catch((error: NodeJS.ErrnoException) => {
        if (!isRemovedDirectoryRace(error.code)) throw error;
      });
      // Delete our marker exactly once: deleting it again could remove a successor's
      // marker. rmdir is safe even after replacement because new locks are non-empty.
      await rmdir(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
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

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT") throw error;
}

function isRemovedDirectoryRace(code: string | undefined): boolean {
  // macOS may report EINVAL when another contender removes the parent during open/unlink.
  return code === "ENOENT" || code === "EINVAL";
}
