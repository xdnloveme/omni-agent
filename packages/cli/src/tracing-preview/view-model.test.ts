import { describe, expect, it } from "vitest";

interface CaptureHealth {
  readonly droppedRecords: number;
  readonly message: string;
}

interface PreviewViewModel {
  captureHealth(run: unknown): CaptureHealth | null;
  selectedRun<T extends { runId: string }>(runId: string | null, runs: readonly T[]): T | null;
}

const viewModel = (await import(
  new URL("./assets/view-model.js", import.meta.url).href
)) as PreviewViewModel;

describe("Trace preview view model", () => {
  it("does not warn for a complete capture", () => {
    expect(viewModel.captureHealth({ status: "completed" })).toBeNull();
  });

  it("describes degraded capture with its dropped record count", () => {
    expect(
      viewModel.captureHealth({
        summary: { capture: { degraded: true, droppedRecords: 3 } },
      }),
    ).toEqual({
      droppedRecords: 3,
      message: "Trace capture is incomplete: 3 records were dropped under storage pressure.",
    });
  });

  it("reconciles a selected run with the latest manifest", () => {
    const stale = { runId: "run", status: "running" };
    const refreshed = {
      runId: "run",
      status: "completed",
      summary: { capture: { degraded: true, droppedRecords: 1 } },
    };

    expect(viewModel.selectedRun(stale.runId, [refreshed])).toBe(refreshed);
    expect(viewModel.captureHealth(viewModel.selectedRun(stale.runId, [refreshed]))).toMatchObject({
      droppedRecords: 1,
    });
  });
});
