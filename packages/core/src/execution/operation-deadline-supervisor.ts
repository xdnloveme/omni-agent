import { createAbortError, throwIfAborted } from "./abort";

export const DEFAULT_CLEANUP_GRACE_MS = 2_000;

export interface LateOperationSettlementEvent {
  operationName: string;
  outcome: "fulfilled" | "rejected";
  error?: unknown;
}

export interface OperationDeadlineSupervisorOptions {
  cleanupGraceMs?: number;
  onLateSettlement?: (event: LateOperationSettlementEvent) => void | Promise<void>;
}

interface SupervisedOperationRequest<T> {
  operationName: string;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
  createTimeoutError(timeoutMs: number): unknown;
  execute(signal: AbortSignal): Promise<T>;
}

/** Owns linked cancellation, deadlines, cleanup grace, and late-settlement observation. */
export class OperationDeadlineSupervisor {
  constructor(private readonly options: OperationDeadlineSupervisorOptions = {}) {}

  async run<T>(request: SupervisedOperationRequest<T>): Promise<T> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(createAbortError(request.externalSignal));
    request.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (request.externalSignal?.aborted) onExternalAbort();

    let deadline: NodeJS.Timeout | undefined;
    let rejectTermination!: (reason: unknown) => void;
    const termination = new Promise<never>((_, reject) => {
      rejectTermination = reject;
    });
    const onLinkedAbort = () => rejectTermination(controller.signal.reason ?? createAbortError());
    controller.signal.addEventListener("abort", onLinkedAbort, { once: true });
    const timeoutMs = request.timeoutMs;
    if (timeoutMs !== undefined) {
      const expiresAt = performance.now() + timeoutMs;
      const schedule = () => {
        const remaining = expiresAt - performance.now();
        deadline = setTimeout(
          () => {
            if (performance.now() >= expiresAt)
              controller.abort(request.createTimeoutError(timeoutMs));
            else schedule();
          },
          Math.min(Math.max(0, remaining), 2_147_483_647),
        );
      };
      schedule();
    }

    let operation: Promise<T> | undefined;
    try {
      throwIfAborted(controller.signal);
      operation = request.execute(controller.signal);
      return await Promise.race([operation, termination]);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (operation) await this.waitForCleanup(request.operationName, operation);
      throw controller.signal.reason ?? error;
    } finally {
      if (deadline) clearTimeout(deadline);
      controller.signal.removeEventListener("abort", onLinkedAbort);
      request.externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async waitForCleanup<T>(operationName: string, operation: Promise<T>): Promise<void> {
    const settled = operation.then(
      () => ({ outcome: "fulfilled" as const }),
      (error) => ({ outcome: "rejected" as const, error }),
    );
    const delay = cancellableDelay(this.options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS);
    const outcome = await Promise.race([settled, delay.promise]);
    delay.cancel();
    if (outcome !== undefined) return;
    void settled.then((event) => this.notifyLateSettlement({ operationName, ...event }));
  }

  private async notifyLateSettlement(event: LateOperationSettlementEvent): Promise<void> {
    try {
      await this.options.onLateSettlement?.(event);
    } catch {
      // Diagnostics must never affect the supervised operation.
    }
  }
}

function cancellableDelay(ms: number): { promise: Promise<undefined>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, ms, undefined);
    }),
    cancel() {
      if (timer) clearTimeout(timer);
    },
  };
}
