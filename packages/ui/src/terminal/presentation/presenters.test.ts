import { describe, expect, it } from "vitest";
import { CompressionEventPresenter } from "./compression-event-presenter";
import { RunMetricsPresenter } from "./run-metrics-presenter";
import { ToolEventPresenter } from "./tool-event-presenter";
import { ToolBatchPresenter } from "./tool-batch-presenter";
import { ThinkingPresenter } from "./thinking-presenter";

describe("CLI stream presenters", () => {
  it("keeps file details lazy and replaces the provisional path with the canonical resource", () => {
    const presenter = new ToolEventPresenter();
    const start = presenter.start(
      "file_read",
      "call",
      { file_path: "src/a.ts" },
      { action: "read", resource: { kind: "file", value: "src/a.ts" } },
    );
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
    presenter.start(
      "bash",
      "call",
      { command: "sleep 10" },
      { action: "execute", resource: { kind: "command", value: "sleep 10" } },
    );
    expect(presenter.cancelPending()).toEqual([
      expect.objectContaining({ id: "tool:call", state: "cancelled" }),
    ]);
    expect(presenter.cancelPending()).toEqual([]);
  });

  it("cancels one pending tool exactly once without adding a batch wrapper", () => {
    const presenter = new ToolBatchPresenter(() => 1_000);
    presenter.start({
      batchId: "batch",
      modelCallId: "call",
      members: [
        {
          toolName: "bash",
          toolCallId: "tool",
          preview: { action: "execute" },
        },
      ],
    });
    presenter.toolStarted(
      "bash",
      "tool",
      { command: "sleep 10" },
      { action: "execute" },
      { batchId: "batch", index: 0, total: 1 },
    );

    expect(presenter.cancelPending()).toEqual([
      expect.objectContaining({ id: "tool:tool", state: "cancelled" }),
    ]);
  });

  it("counts failed children as finished while a batch continues", () => {
    const presenter = new ToolBatchPresenter(() => 1_000);
    presenter.start({
      batchId: "batch",
      modelCallId: "call",
      members: [
        { toolName: "bash", toolCallId: "one", preview: { action: "execute" } },
        { toolName: "bash", toolCallId: "two", preview: { action: "execute" } },
      ],
    });
    presenter.toolStarted(
      "bash",
      "one",
      { command: "false" },
      { action: "execute" },
      { batchId: "batch", index: 0, total: 2 },
    );
    const failed = presenter.toolCompleted(
      "one",
      { content: [{ type: "text", text: "failed" }], isError: true },
      10,
      { batchId: "batch", index: 0, total: 2 },
    );

    expect(failed).toMatchObject({ summary: "1/2 done · 1 failed", initiallyExpanded: true });
  });

  it("progressively groups multiple tools while leaving child disclosures intact", () => {
    const presenter = new ToolBatchPresenter(() => 1_000);
    const started = presenter.start({
      batchId: "batch",
      modelCallId: "model-call",
      members: [
        {
          toolName: "bash",
          toolCallId: "bash-1",
          preview: {
            action: "execute",
            resource: { kind: "command", value: "pnpm test" },
          },
        },
        {
          toolName: "file_read",
          toolCallId: "read-1",
          preview: {
            action: "read",
            resource: { kind: "file", value: "src/index.ts" },
          },
        },
      ],
    });
    expect(started).toMatchObject({
      id: "tool-batch:batch",
      summary: "0/2 done",
      state: "running",
    });
    expect(started?.children?.map((child) => child.state)).toEqual(["waiting", "waiting"]);

    const running = presenter.toolStarted(
      "bash",
      "bash-1",
      { command: "pnpm test" },
      { action: "execute", resource: { kind: "command", value: "pnpm test" } },
      { batchId: "batch", index: 0, total: 2 },
    );
    expect(running?.summary).toBe("0/2 done");

    const progressed = presenter.toolCompleted(
      "bash-1",
      { content: [{ type: "text", text: "passed" }], isError: false },
      800,
      { batchId: "batch", index: 0, total: 2 },
    );
    expect(progressed?.summary).toBe("1/2 done");

    presenter.toolStarted(
      "file_read",
      "read-1",
      { file_path: "src/index.ts" },
      { action: "read", resource: { kind: "file", value: "src/index.ts" } },
      { batchId: "batch", index: 1, total: 2 },
    );
    presenter.toolCompleted(
      "read-1",
      { content: [{ type: "text", text: "content" }], isError: false },
      20,
      { batchId: "batch", index: 1, total: 2 },
    );
    const completed = presenter.complete("batch", "model-call", 1_200);
    expect(completed).toMatchObject({
      title: "Tool Calls",
      state: "completed",
      summary: "2/2 completed · 1.2s",
    });
    expect(completed?.children?.map((child) => child.state)).toEqual(["completed", "completed"]);
  });

  it("streams thinking in one disclosure and folds it after completion", () => {
    let now = 1_000;
    const presenter = new ThinkingPresenter(() => now);
    presenter.start("model-call", 0);
    const running = presenter.append("model-call", 0, "Inspecting the runtime");
    expect(running).toMatchObject({
      id: "thinking:model-call:0",
      title: "Thinking",
      state: "running",
      initiallyExpanded: true,
    });
    expect(running?.details()).toEqual(["Inspecting the runtime"]);

    now = 2_200;
    const completed = presenter.complete("model-call", 0, "Inspecting the runtime");
    expect(completed).toMatchObject({
      state: "completed",
      summary: "1.2s",
      initiallyExpanded: false,
      collapseOnComplete: true,
    });
  });

  it("maps one compression lifecycle to one stable disclosure id", () => {
    const presenter = new CompressionEventPresenter();
    const started = presenter.present({
      type: "compression_started",
      compressionId: "compression-1",
      modelCallId: "call",
      beforeTokens: 100,
      startedKind: "artifact_projection",
      trigger: { inputTokens: 100, usableInputBudget: 120, thresholdTokens: 90 },
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
        trigger: { inputTokens: 100, usableInputBudget: 120, thresholdTokens: 90 },
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
    expect(completed.details()).toContain("trigger threshold: 90");
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
    const metrics = presenter.present({
      inputTokens: 47_600,
      outputTokens: 100,
      totalTokens: 47_700,
      contextWindow: 128_000,
      usableInputBudget: 120_000,
      requestedOutputTokens: 8_000,
    });
    expect(metrics.full).toContain("Context: 47,600 / 120,000 input tokens (40%)");
    expect(metrics.full).toContain("Window: 37%");
    expect(metrics.full).toContain("Cache hit: 68%");
  });
});
