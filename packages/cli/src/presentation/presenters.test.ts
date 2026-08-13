import { describe, expect, it } from "vitest";
import { CompressionEventPresenter } from "./compression-event-presenter";
import { RunMetricsPresenter } from "./run-metrics-presenter";
import { ToolEventPresenter } from "./tool-event-presenter";

describe("CLI stream presenters", () => {
  it("keeps file details lazy and replaces the provisional path with the canonical resource", () => {
    const presenter = new ToolEventPresenter();
    const start = presenter.start("file_read", "call", { file_path: "src/a.ts" });
    expect(start.summary).toBe("src/a.ts");
    const completed = presenter.complete(
      "call",
      {
        content: [{ type: "text", text: "1|export const a = 1;" }],
        isError: false,
        meta: {
          presentation: { resource: { kind: "file", path: "/workspace/src/a.ts" } },
          pagination: { startLine: 1, endLine: 1, fileVersion: "abc" },
        },
      },
      24,
    );
    expect(completed?.summary).toBe("/workspace/src/a.ts · 24ms");
    expect(completed?.details()).toContain("range: lines 1–1");
  });

  it("closes an unfinished tool disclosure when its run is cancelled", () => {
    const presenter = new ToolEventPresenter(() => 1_000);
    presenter.start("bash", "call", { command: "sleep 10" });
    expect(presenter.cancelPending()).toEqual([
      expect.objectContaining({ id: "tool:call", state: "cancelled" }),
    ]);
    expect(presenter.cancelPending()).toEqual([]);
  });

  it("maps one compression lifecycle to one stable disclosure id", () => {
    const presenter = new CompressionEventPresenter();
    const started = presenter.present({
      type: "compression_started",
      compressionId: "compression-1",
      modelCallId: "call",
      beforeTokens: 100,
      startedKind: "artifact_projection",
    });
    const completed = presenter.present({
      type: "compression_completed",
      compressionId: "compression-1",
      modelCallId: "call",
      report: {
        beforeTokens: 100,
        afterTokens: 50,
        tokenDelta: 50,
        reductionRatio: 0.5,
        operations: [
          { kind: "artifact_projection", affectedCount: 2 },
          { kind: "thinking_projection", affectedCount: 3 },
          { kind: "heavy_checkpoint", affectedCount: 8, action: "create" },
        ],
        durationMs: 10,
      },
    });
    expect(completed.id).toBe(started.id);
    expect(completed.summary).toContain("↓50.0%");
    expect(completed.summary).toContain("Artifact + Thinking + Heavy");
  });

  it("shows cache hit only for the successful report matching the latest context", () => {
    const presenter = new RunMetricsPresenter();
    presenter.recordContext({ snapshotId: "previous" } as never);
    presenter.recordCache({
      outcome: "success",
      contextSnapshotId: "previous",
      cacheHitRate: 0.99,
    } as never);
    presenter.recordContext({ snapshotId: "latest" } as never);
    presenter.recordCache({
      outcome: "success",
      contextSnapshotId: "other",
      cacheHitRate: 0.95,
    } as never);
    presenter.recordCache({
      outcome: "success",
      contextSnapshotId: "latest",
      cacheHitRate: 0.68,
    } as never);
    expect(
      presenter.present({
        inputTokens: 47_600,
        outputTokens: 100,
        totalTokens: 47_700,
        contextWindow: 128_000,
      }).full,
    ).toContain("Cache hit: 68%");
  });
});
