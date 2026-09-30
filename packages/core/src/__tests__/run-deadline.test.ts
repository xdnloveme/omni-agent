import { afterEach, expect, it, vi } from "vitest";
import { RunDeadline } from "../execution/run-deadline";
afterEach(() => vi.useRealTimers());
it("uses monotonic elapsed time after the initial wall-clock conversion", () => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(10000);
  const deadline = new RunDeadline(11000);
  vi.setSystemTime(900000);
  expect(deadline.snapshot().remainingMs).toBe(1000);
  vi.advanceTimersByTime(400);
  expect(deadline.snapshot()).toEqual({
    deadlineAtMs: 11000,
    capturedAtMs: 10400,
    remainingMs: 600,
  });
});
