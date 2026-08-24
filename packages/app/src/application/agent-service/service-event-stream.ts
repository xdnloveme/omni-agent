import type { AgentServiceEvent } from "./contracts";
import { AgentServiceError } from "./contracts";

interface PendingRead {
  readonly resolve: (result: IteratorResult<AgentServiceEvent>) => void;
}

/** Hot after the first read; returning the iterator cancels its owning request. */
export class ServiceEventStream implements AsyncIterable<AgentServiceEvent> {
  private readonly queue: AgentServiceEvent[] = [];
  private readonly reads: PendingRead[] = [];
  private started = false;
  private ended = false;
  private iteratorCreated = false;

  constructor(
    private readonly onStart: () => void,
    private readonly onCancel: () => void,
  ) {}

  push(event: AgentServiceEvent): void {
    if (this.ended) return;
    const read = this.reads.shift();
    if (read) read.resolve({ done: false, value: event });
    else this.queue.push(event);
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.flushCompletedReads();
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentServiceEvent> {
    if (this.iteratorCreated) {
      throw new AgentServiceError(
        "event_stream_already_consumed",
        "Agent service event stream can only be consumed once",
      );
    }
    this.iteratorCreated = true;
    return {
      next: () => this.next(),
      return: async () => {
        if (!this.ended) this.onCancel();
        this.ended = true;
        this.queue.length = 0;
        this.flushCompletedReads();
        return { done: true, value: undefined };
      },
    };
  }

  private next(): Promise<IteratorResult<AgentServiceEvent>> {
    if (!this.started) {
      this.started = true;
      this.onStart();
    }
    const event = this.queue.shift();
    if (event) return Promise.resolve({ done: false, value: event });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.reads.push({ resolve }));
  }

  private flushCompletedReads(): void {
    if (this.queue.length > 0) return;
    for (const read of this.reads.splice(0)) {
      read.resolve({ done: true, value: undefined });
    }
  }
}
