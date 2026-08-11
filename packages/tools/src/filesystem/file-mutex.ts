import fs from "node:fs/promises";
import path from "node:path";
import { createAbortError, throwIfAborted } from "@omni-agent/core";

/**
 * Per-file Promise-chain mutex.
 * Same file → serial execution. Different files → parallel.
 * Global singleton exported as `fileMutex`.
 */
interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface LockQueue {
  locked: boolean;
  waiters: Waiter[];
}

export class FileMutex {
  private readonly queues = new Map<string, LockQueue>();

  async withLock<T>(
    filePath: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const pathKey = `path:${path.resolve(filePath)}`;
    await this.acquire(pathKey, signal);
    let inodeKey: string | undefined;
    let inodeAcquired = false;
    try {
      inodeKey = await resolveInodeKey(filePath);
      if (inodeKey) {
        await this.acquire(inodeKey, signal);
        inodeAcquired = true;
      }
      throwIfAborted(signal);
      return await fn();
    } finally {
      if (inodeKey && inodeAcquired) this.release(inodeKey);
      this.release(pathKey);
    }
  }

  private acquire(key: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const queue = this.queues.get(key) ?? { locked: false, waiters: [] };
    this.queues.set(key, queue);
    if (!queue.locked) {
      queue.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = queue.waiters.indexOf(waiter);
        if (index >= 0) queue.waiters.splice(index, 1);
        reject(createAbortError(signal));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      queue.waiters.push(waiter);
    });
  }

  private release(key: string): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    const waiter = queue.waiters.shift();
    if (waiter) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
      return;
    }
    queue.locked = false;
    this.queues.delete(key);
  }
}

async function resolveInodeKey(filePath: string): Promise<string | undefined> {
  const resolved = path.resolve(filePath);
  try {
    const stats = await fs.stat(resolved, { bigint: true });
    return `inode:${stats.dev.toString(10)}:${stats.ino.toString(10)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export const fileMutex = new FileMutex();
