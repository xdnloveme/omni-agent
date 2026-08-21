import type {
  ContextCompressionKind,
  ContextCompressionOperationSummary,
  ContextCompressionReport,
  ContextCompressionTrigger,
  ContextProgressEvent,
} from "@omni-agent/core";
import type { DisclosureViewModel } from "./view-models";
import { formatDuration } from "./format";

const TYPE_LABELS: Record<ContextCompressionKind, { full: string; compact: string }> = {
  artifact_projection: { full: "Artifact projection", compact: "Artifact" },
  skill_projection: { full: "Skill projection", compact: "Skill" },
  thinking_projection: { full: "Thinking projection", compact: "Thinking" },
  heavy_checkpoint: { full: "Heavy checkpoint", compact: "Heavy" },
};

export class CompressionEventPresenter {
  private readonly startedKinds = new Map<string, ContextCompressionKind>();

  constructor(private readonly now: () => number = Date.now) {}

  present(event: ContextProgressEvent): DisclosureViewModel {
    switch (event.type) {
      case "compression_started":
        this.startedKinds.set(event.compressionId, event.startedKind);
        return {
          id: compressionViewId(event.compressionId),
          title: "Context compression",
          summary: `compressing… · ${TYPE_LABELS[event.startedKind].compact}`,
          state: "running",
          startedAt: this.now(),
          tone: "neutral",
          details: () => [
            `type: ${TYPE_LABELS[event.startedKind].full}`,
            ...triggerDetails(event.trigger),
          ],
          initiallyExpanded: false,
        };
      case "compression_completed": {
        this.startedKinds.delete(event.compressionId);
        const summary = reductionSummary(event.report.reductionRatio, event.report.operations);
        return {
          id: compressionViewId(event.compressionId),
          title: "Context compression",
          summary,
          state: "completed",
          tone: event.report.tokenDelta < 0 ? "warning" : "success",
          details: () => completedDetails(event.report),
          initiallyExpanded: false,
        };
      }
      case "compression_failed": {
        const kind = this.startedKinds.get(event.compressionId);
        this.startedKinds.delete(event.compressionId);
        return {
          id: compressionViewId(event.compressionId),
          title: "Context compression",
          summary: event.cancelled ? "cancelled" : "error",
          state: event.cancelled ? "cancelled" : "failed",
          tone: event.cancelled ? "warning" : "error",
          details: () => [
            ...(kind ? [`type: ${TYPE_LABELS[kind].full}`] : []),
            `reason: ${event.reason}`,
          ],
          initiallyExpanded: !event.cancelled,
        };
      }
    }
  }

  cancelPending(): readonly DisclosureViewModel[] {
    const cancelled = [...this.startedKinds.entries()].map(([compressionId, kind]) => ({
      id: compressionViewId(compressionId),
      title: "Context compression",
      summary: "cancelled",
      state: "cancelled" as const,
      tone: "warning" as const,
      details: () => [`type: ${TYPE_LABELS[kind].full}`, "reason: run cancelled"],
      initiallyExpanded: false,
    }));
    this.startedKinds.clear();
    return cancelled;
  }
}

function compressionViewId(compressionId: string): string {
  return `compression:${compressionId}`;
}

function reductionSummary(
  ratio: number,
  operations: readonly ContextCompressionOperationSummary[],
): string {
  const types = [
    ...new Set(operations.map((operation) => TYPE_LABELS[operation.kind].compact)),
  ].join(" + ");
  const suffix = types ? ` · ${types}` : "";
  if (ratio === 0) return `no token reduction${suffix}`;
  return `${ratio > 0 ? "↓" : "↑"}${Math.abs(ratio * 100).toFixed(1)}%${suffix}`;
}

function completedDetails(report: ContextCompressionReport): readonly string[] {
  const lines = ["types:"];
  for (const operation of report.operations) {
    lines.push(`  - ${TYPE_LABELS[operation.kind].full}`);
  }
  if (report.operations.length === 0) lines.push("  - No projection changed");
  lines.push("compressed:");
  for (const operation of report.operations) lines.push(`  - ${operationText(operation)}`);
  if (report.operations.length === 0) lines.push("  - No token-bearing content changed");
  lines.push(
    ...triggerDetails(report.trigger),
    `tokens: ${report.beforeTokens.toLocaleString()} → ${report.afterTokens.toLocaleString()}`,
    `reduction: ${(report.reductionRatio * 100).toFixed(1)}%`,
    `duration: ${formatDuration(report.durationMs)}`,
  );
  return lines;
}

function triggerDetails(trigger: ContextCompressionTrigger): readonly string[] {
  const pressure =
    trigger.usableInputBudget > 0
      ? ((trigger.inputTokens / trigger.usableInputBudget) * 100).toFixed(1)
      : "—";
  return [
    `trigger pressure: ${trigger.inputTokens.toLocaleString()} / ${trigger.usableInputBudget.toLocaleString()} (${pressure}%)`,
    `trigger threshold: ${trigger.thresholdTokens.toLocaleString()}`,
  ];
}

function operationText(operation: ContextCompressionOperationSummary): string {
  switch (operation.kind) {
    case "artifact_projection":
      return `${operation.affectedCount} historical tool results externalized`;
    case "skill_projection":
      return `${operation.affectedCount} historical skill results projected`;
    case "thinking_projection":
      return `${operation.affectedCount} historical thinking blocks cleared`;
    case "heavy_checkpoint":
      return `${operation.affectedCount} transcript messages checkpointed (${operation.action ?? "create"})`;
  }
}
