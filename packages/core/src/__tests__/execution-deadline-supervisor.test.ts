import { describe, expect, it, vi } from "vitest";
import { ExecutionDeadlineSupervisor } from "../execution/execution-deadline-supervisor";

describe("ExecutionDeadlineSupervisor", () => {
  it("clears the cleanup timer after cooperative cancellation", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const supervisor = new ExecutionDeadlineSupervisor({ cleanupGraceMs: 2_000 });
      const pending = supervisor.run({
        toolName: "cooperative",
        externalSignal: controller.signal,
        execute: async (signal) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      });

      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates an asynchronous late-settlement observer failure", async () => {
    let finishExecution!: () => void;
    const observer = vi.fn(async () => {
      throw new Error("diagnostic failure");
    });
    const supervisor = new ExecutionDeadlineSupervisor({
      cleanupGraceMs: 1,
      onLateSettlement: observer,
    });
    const result = await supervisor
      .run({
        toolName: "late",
        timeoutMs: 1,
        execute: async () =>
          await new Promise((resolve) => {
            finishExecution = () =>
              resolve({ content: [{ type: "text", text: "late" }], isError: false });
          }),
      })
      .catch((error: unknown) => error);

    expect(result).toMatchObject({ code: "tool_timeout" });
    finishExecution();
    await new Promise(setImmediate);
    expect(observer).toHaveBeenCalledWith({ toolName: "late", outcome: "fulfilled" });
  });
});
