import path from "node:path";

/**
 * Per-file Promise-chain mutex.
 * Same file → serial execution. Different files → parallel.
 * Global singleton exported as `fileMutex`.
 */
class FileMutex {
  private locks = new Map<string, Promise<void>>();

  async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(filePath);
    const prev = this.locks.get(key) ?? Promise.resolve();

    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(key, next);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      // Clean up only if we are still the tail of the chain
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }
}

export const fileMutex = new FileMutex();
