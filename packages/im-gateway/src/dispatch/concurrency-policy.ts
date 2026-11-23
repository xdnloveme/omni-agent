import { createAbortError, throwIfAborted } from "@omni-agent/core";

export interface DispatchPermit {
  readonly queued: boolean;
  release(): void;
}

export interface ConcurrencyPolicy {
  acquire(signal?: AbortSignal): Promise<DispatchPermit>;
  readonly serial: boolean;
  readonly active: number;
  readonly queued: number;
}

export class ConcurrentPolicy implements ConcurrencyPolicy {
  readonly serial = false;
  #active = 0;

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return 0;
  }

  acquire(signal?: AbortSignal): Promise<DispatchPermit> {
    throwIfAborted(signal);
    const queued = this.#active > 0;
    this.#active += 1;
    let released = false;
    return Promise.resolve({
      queued,
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
      },
    });
  }
}

export class SerialPolicy implements ConcurrencyPolicy {
  readonly serial = true;
  #active = 0;
  readonly #waiters: Array<{
    readonly resolve: (permit: DispatchPermit) => void;
    readonly reject: (error: Error) => void;
    readonly signal?: AbortSignal;
    readonly onAbort: () => void;
  }> = [];

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<DispatchPermit> {
    throwIfAborted(signal);
    if (this.#active === 0) {
      this.#active = 1;
      return this.#permit(false);
    }
    const permit = await new Promise<DispatchPermit>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(createAbortError(signal));
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
    try {
      throwIfAborted(signal);
      return permit;
    } catch (error) {
      permit.release();
      throw error;
    }
  }

  #permit(queued: boolean): DispatchPermit {
    let released = false;
    return {
      queued,
      release: () => {
        if (released) return;
        released = true;
        this.#grantNext();
      },
    };
  }

  #grantNext(): void {
    while (true) {
      const next = this.#waiters.shift();
      if (!next) {
        this.#active = 0;
        return;
      }
      next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.reject(createAbortError(next.signal));
        continue;
      }
      next.resolve(this.#permit(true));
      return;
    }
  }
}
