import type { ModelCacheReport, ModelContextSnapshotManifest, TokenUsage } from "@omni-agent/core";
import type { RunMetricsViewModel } from "./view-models";

export class RunMetricsPresenter {
  private latestSnapshotId: string | undefined;
  private latestCache: ModelCacheReport | undefined;

  recordContext(manifest: ModelContextSnapshotManifest): void {
    this.latestSnapshotId = manifest.snapshotId;
    this.latestCache = undefined;
  }

  recordCache(report: ModelCacheReport): void {
    if (
      report.outcome === "success" &&
      report.contextSnapshotId &&
      report.contextSnapshotId === this.latestSnapshotId
    ) {
      this.latestCache = report;
    }
  }

  present(usage: TokenUsage): RunMetricsViewModel {
    const pressurePercent = Math.round((usage.inputTokens / usage.usableInputBudget) * 100);
    const windowPercent = Math.round((usage.inputTokens / usage.contextWindow) * 100);
    const cache = formatCacheRate(this.latestCache?.cacheHitRate);
    const input = `${usage.estimated ? "~" : ""}${usage.inputTokens.toLocaleString()}`;
    return {
      full: `Context: ${input} / ${usage.usableInputBudget.toLocaleString()} input tokens (${pressurePercent}%) · Window: ${windowPercent}% · Cache hit: ${cache}`,
      compact: `Context ${pressurePercent}% · Cache hit ${cache}`,
      minimal: `Ctx ${pressurePercent}% · Cache ${cache}`,
      usagePercent: pressurePercent,
    };
  }
}

function formatCacheRate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}
