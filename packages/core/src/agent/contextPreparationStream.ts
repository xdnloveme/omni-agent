import type {
  ContextEnginePort,
  ContextPreparationRequest,
  ContextProgressEvent,
  ContextProgressSinkPort,
  PreparedModelContext,
} from "../context";

export interface ContextPreparationStream {
  readonly progress: AsyncIterable<ContextProgressEvent>;
  result(): Promise<PreparedModelContext>;
}

export function createContextPreparationStream(
  engine: ContextEnginePort,
  createRequest: (progress: ContextProgressSinkPort) => ContextPreparationRequest,
): ContextPreparationStream {
  const progress = new AsyncEventQueue<ContextProgressEvent>();
  const completion = engine.prepare(createRequest(progress)).then(
    (context) => ({ ok: true as const, context }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void completion.then(() => progress.close());
  return {
    progress,
    async result() {
      const outcome = await completion;
      if (!outcome.ok) throw outcome.error;
      return outcome.context;
    },
  };
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  publish(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ done: false, value: this.values.shift()! });
        }
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
