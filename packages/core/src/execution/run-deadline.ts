export interface RunDeadlineSnapshot {
  readonly deadlineAtMs: number;
  readonly capturedAtMs: number;
  readonly remainingMs: number;
}

export class InvalidRunDeadlineError extends Error {
  readonly code = "invalid_run_deadline";
  constructor() {
    super("Run deadlineAtMs must be a safe integer UTC timestamp");
  }
}

export function assertRunDeadline(deadlineAtMs: number | undefined): void {
  if (deadlineAtMs !== undefined && !Number.isSafeInteger(deadlineAtMs)) {
    throw new InvalidRunDeadlineError();
  }
}

/** One wall-clock conversion per Run; subsequent elapsed time is monotonic. */
export class RunDeadline {
  private readonly wallStart = Date.now();
  private readonly monotonicStart = performance.now();
  constructor(readonly deadlineAtMs: number) {
    assertRunDeadline(deadlineAtMs);
  }
  snapshot(): RunDeadlineSnapshot {
    const capturedAtMs = this.wallStart + Math.max(0, performance.now() - this.monotonicStart);
    return {
      deadlineAtMs: this.deadlineAtMs,
      capturedAtMs,
      remainingMs: Math.max(0, this.deadlineAtMs - capturedAtMs),
    };
  }
}

export class RunDeadlineExceededError extends Error {
  readonly code = "run_deadline_exceeded";
  constructor() {
    super("Run deadline exceeded");
    this.name = "AbortError";
  }
}
