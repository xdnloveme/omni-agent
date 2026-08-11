import type { ToolResult } from "../types";
import { createAbortError, throwIfAborted } from "./abort";
import { ToolTimeoutError } from "./tool-timeout-error";

const DEFAULT_CLEANUP_GRACE_MS = 2_000;

export interface LateToolSettlementEvent {
  toolName: string;
  outcome: "fulfilled" | "rejected";
  error?: unknown;
}

export interface ExecutionDeadlineSupervisorOptions {
  cleanupGraceMs?: number;
  onLateSettlement?: (event: LateToolSettlementEvent) => void | Promise<void>;
}

interface SupervisedExecutionRequest {
  toolName: string;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
  execute(signal: AbortSignal): Promise<ToolResult>;
}

export class ExecutionDeadlineSupervisor {
  constructor(private readonly options: ExecutionDeadlineSupervisorOptions = {}) {}

  async run(request: SupervisedExecutionRequest): Promise<ToolResult> {
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
      deadline = setTimeout(() => controller.abort(new ToolTimeoutError(timeoutMs)), timeoutMs);
    }

    let execution: Promise<ToolResult> | undefined;
    try {
      throwIfAborted(controller.signal);
      execution = request.execute(controller.signal);
      return await Promise.race([execution, termination]);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (execution) await this.waitForCleanup(request.toolName, execution);
      throw controller.signal.reason ?? error;
    } finally {
      if (deadline) clearTimeout(deadline);
      controller.signal.removeEventListener("abort", onLinkedAbort);
      request.externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async waitForCleanup(toolName: string, execution: Promise<ToolResult>): Promise<void> {
    const settled = execution.then(
      () => ({ outcome: "fulfilled" as const }),
      (error) => ({ outcome: "rejected" as const, error }),
    );
    const delay = cancellableDelay(this.options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS);
    const outcome = await Promise.race([settled, delay.promise]);
    delay.cancel();
    if (outcome !== undefined) return;
    void settled.then((event) => this.notifyLateSettlement({ toolName, ...event }));
  }

  private async notifyLateSettlement(event: LateToolSettlementEvent): Promise<void> {
    try {
      await this.options.onLateSettlement?.(event);
    } catch {
      // Diagnostics must never affect execution.
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
