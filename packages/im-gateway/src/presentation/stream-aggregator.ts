export interface StreamAggregatorOptions {
  readonly intervalMs?: number;
  readonly update: (text: string) => Promise<void>;
}

export class StreamAggregator {
  readonly #intervalMs: number;
  #text = "";
  #dirty = false;
  #timer?: ReturnType<typeof setTimeout>;
  #tail = Promise.resolve();
  #lastError: unknown;
  #closed = false;

  constructor(private readonly options: StreamAggregatorOptions) {
    this.#intervalMs = options.intervalMs ?? 500;
  }

  append(delta: string): void {
    if (this.#closed || !delta) return;
    this.#text += delta;
    this.#dirty = true;
    this.#schedule();
  }

  replace(text: string): void {
    if (this.#closed) return;
    this.#text = text;
    this.#dirty = true;
    this.#schedule();
  }

  async flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#dirty) return this.#tail;
    this.#dirty = false;
    const text = this.#text;
    const operation = this.#tail.then(() => this.options.update(text));
    this.#tail = operation.catch(() => undefined);
    try {
      await operation;
      this.#lastError = undefined;
    } catch (error) {
      this.#lastError = error;
      if (this.#text === text) this.#dirty = true;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.flush();
    if (this.#lastError) throw this.#lastError;
    this.#closed = true;
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush().catch((error) => {
        this.#lastError = error;
      });
    }, this.#intervalMs);
  }
}
