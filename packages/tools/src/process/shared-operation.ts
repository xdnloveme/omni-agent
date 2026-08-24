import { createAbortError, throwIfAborted } from "@omni-agent/core";

/** Shares one cancellable operation without coupling individual waiter cancellation. */
export class SharedOperation<T> {
  readonly completion: Promise<T>;
  private readonly controller = new AbortController();
  private waiters = 0;
  private settled = false;

  constructor(
    execute: (signal: AbortSignal) => Promise<T>,
    private readonly onAbandoned?: () => void,
  ) {
    this.completion = execute(this.controller.signal).finally(() => {
      this.settled = true;
    });
    this.completion.catch(() => undefined);
  }

  wait(signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    this.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        this.waiters -= 1;
        if (!this.settled && this.waiters === 0) {
          this.controller.abort();
          this.onAbandoned?.();
        }
        callback();
      };
      const onAbort = () => finish(() => reject(createAbortError(signal)));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.completion.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
}
