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
    const percent = Math.round((usage.inputTokens / usage.contextWindow) * 100);
    const cache = formatCacheRate(this.latestCache?.cacheHitRate);
    const input = `${usage.estimated ? "~" : ""}${usage.inputTokens.toLocaleString()}`;
    return {
      full: `Context: ${input} / ${usage.contextWindow.toLocaleString()} tokens (${percent}%) · Cache hit: ${cache}`,
      compact: `Context ${percent}% · Cache hit ${cache}`,
      minimal: `Ctx ${percent}% · Cache ${cache}`,
      usagePercent: percent,
    };
  }
}

function formatCacheRate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}
