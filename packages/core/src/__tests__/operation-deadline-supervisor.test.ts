import { describe, expect, it, vi } from "vitest";
import { ToolTimeoutError } from "../execution/tool-timeout-error";
import { OperationDeadlineSupervisor } from "../execution/operation-deadline-supervisor";

describe("OperationDeadlineSupervisor", () => {
  it("clears the cleanup timer after cooperative cancellation", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const supervisor = new OperationDeadlineSupervisor({ cleanupGraceMs: 2_000 });
      const pending = supervisor.run({
        operationName: "cooperative",
        externalSignal: controller.signal,
        createTimeoutError: (timeoutMs) => new ToolTimeoutError(timeoutMs),
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
    const supervisor = new OperationDeadlineSupervisor({
      cleanupGraceMs: 1,
      onLateSettlement: observer,
    });
    const result = await supervisor
      .run({
        operationName: "late",
        timeoutMs: 1,
        createTimeoutError: (timeoutMs) => new ToolTimeoutError(timeoutMs),
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
    expect(observer).toHaveBeenCalledWith({ operationName: "late", outcome: "fulfilled" });
  });
});

it("does not overflow long deadlines and removes the chunked timer on cancellation", async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const pending = new OperationDeadlineSupervisor().run({
      operationName: "long",
      timeoutMs: 2_147_483_648,
      externalSignal: controller.signal,
      createTimeoutError: (ms) => new ToolTimeoutError(ms),
      execute: (signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    });
    const outcome = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
