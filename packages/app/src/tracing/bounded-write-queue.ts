export type TraceWritePriority = "critical" | "detail";

interface TraceWriteEntry {
  readonly operation: () => Promise<void>;
  readonly priority: TraceWritePriority;
  readonly onDrop?: () => void;
}

export interface BoundedTraceWriteQueueOptions {
  readonly capacity: number;
  readonly onDiagnostic?: (message: string) => void;
}

export class BoundedTraceWriteQueue {
  private readonly entries: TraceWriteEntry[] = [];
  private running = false;
  private dropped = 0;
  private reportedDrop = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  constructor(private readonly options: BoundedTraceWriteQueueOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error("Trace write queue capacity must be a positive integer");
    }
  }

  enqueue(
    operation: () => Promise<void>,
    priority: TraceWritePriority,
    onDrop?: () => void,
  ): boolean {
    if (this.size >= this.options.capacity && !this.makeRoom(priority)) {
      this.notifyDrop(onDrop);
      this.drop();
      return false;
    }
    this.entries.push({ operation, priority, onDrop });
    this.start();
    return true;
  }

  flush(): Promise<void> {
    return this.idle;
  }

  private get size(): number {
    return this.entries.length + (this.running ? 1 : 0);
  }

  private makeRoom(priority: TraceWritePriority): boolean {
    if (priority === "detail") return false;
    const detailIndex = this.entries.findIndex((entry) => entry.priority === "detail");
    if (detailIndex >= 0) {
      this.notifyDrop(this.entries.splice(detailIndex, 1)[0]?.onDrop);
    } else if (this.entries.length > 0) {
      this.notifyDrop(this.entries.shift()?.onDrop);
    } else {
      return false;
    }
    this.drop();
    return true;
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.idle = new Promise((resolve) => {
      this.resolveIdle = resolve;
    });
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.entries.length > 0) {
      const entry = this.entries.shift()!;
      try {
        await entry.operation();
      } catch {
        continue;
      }
    }
    this.running = false;
    this.reportedDrop = false;
    this.resolveIdle?.();
    this.resolveIdle = undefined;
  }

  private drop(): void {
    this.dropped += 1;
    if (this.reportedDrop) return;
    this.reportedDrop = true;
    try {
      this.options.onDiagnostic?.(
        `Trace write queue is full; records are being dropped (${this.dropped} dropped)`,
      );
    } catch {
      return;
    }
  }

  private notifyDrop(onDrop: (() => void) | undefined): void {
    try {
      onDrop?.();
    } catch {
      return;
    }
  }
}
