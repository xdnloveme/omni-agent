import { randomUUID } from "node:crypto";
import { isAbortError } from "../../execution";
import type {
  ContextCompressionKind,
  ContextCompressionOperationSummary,
  ContextCompressionReporterPort,
  ContextProgressSinkPort,
} from "../contracts/progress";
import type { ContextTokenEstimate } from "../contracts/types";

export class ContextCompressionProgressCollector implements ContextCompressionReporterPort {
  private compressionId: string | undefined;
  private beforeTokens = 0;
  private startedAt = 0;
  private closed = false;
  private readonly operations: ContextCompressionOperationSummary[] = [];

  constructor(
    private readonly modelCallId: string,
    private readonly sink: ContextProgressSinkPort,
    private readonly initialEstimate: ContextTokenEstimate,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {}

  begin(kind: ContextCompressionKind): void {
    if (this.closed || this.compressionId) return;
    this.compressionId = this.createId();
    this.beforeTokens = this.initialEstimate.totalInputTokens;
    this.startedAt = this.now();
    this.publish({
      type: "compression_started",
      compressionId: this.compressionId,
      modelCallId: this.modelCallId,
      beforeTokens: this.beforeTokens,
      startedKind: kind,
    });
  }

  record(operation: ContextCompressionOperationSummary): void {
    if (!this.compressionId || this.closed) return;
    this.operations.push({ ...operation });
  }

  complete(estimate: ContextTokenEstimate): void {
    if (!this.compressionId || this.closed) return;
    this.closed = true;
    const afterTokens = estimate.totalInputTokens;
    const tokenDelta = this.beforeTokens - afterTokens;
    this.publish({
      type: "compression_completed",
      compressionId: this.compressionId,
      modelCallId: this.modelCallId,
      report: {
        beforeTokens: this.beforeTokens,
        afterTokens,
        tokenDelta,
        reductionRatio: this.beforeTokens > 0 ? tokenDelta / this.beforeTokens : 0,
        operations: this.operations.map((operation) => ({ ...operation })),
        durationMs: Math.max(0, this.now() - this.startedAt),
      },
    });
  }

  fail(error: unknown): void {
    if (!this.compressionId || this.closed) return;
    this.closed = true;
    this.publish({
      type: "compression_failed",
      compressionId: this.compressionId,
      modelCallId: this.modelCallId,
      reason: error instanceof Error ? error.message : String(error),
      cancelled: isAbortError(error),
    });
  }

  private publish(event: Parameters<ContextProgressSinkPort["publish"]>[0]): void {
    try {
      this.sink.publish(event);
    } catch {
      // Presentation observers are deliberately isolated from context preparation.
    }
  }
}
