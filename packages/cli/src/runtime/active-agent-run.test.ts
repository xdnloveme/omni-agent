import { describe, expect, it, vi } from "vitest";
import { ActiveAgentRun, ActiveAgentRunError } from "./active-agent-run";

describe("ActiveAgentRun", () => {
  it("aborts and joins the single active operation before closing", async () => {
    const run = new ActiveAgentRun();
    let settle!: () => void;
    const operation = run.run(
      (signal) =>
        new Promise<void>((resolve) => {
          settle = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    await Promise.resolve();

    const closing = run.close();
    expect(run.state).toBe("closing");
    await closing;
    await operation;
    expect(run.state).toBe("closed");
    settle();
  });

  it("rejects concurrent and post-close runs", async () => {
    const run = new ActiveAgentRun();
    let resolve!: () => void;
    const first = run.run(() => new Promise<void>((done) => (resolve = done)));
    await expect(run.run(async () => undefined)).rejects.toMatchObject({
      code: "active_run_busy",
    } satisfies Partial<ActiveAgentRunError>);
    resolve();
    await first;
    await run.close();
    await expect(run.run(async () => undefined)).rejects.toMatchObject({
      code: "active_run_closed",
    } satisfies Partial<ActiveAgentRunError>);
  });

  it("interrupts at most once and makes close idempotent", async () => {
    const run = new ActiveAgentRun();
    const aborted = vi.fn();
    const active = run.run(
      (signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => {
            aborted();
            resolve();
          }),
        ),
    );
    await Promise.resolve();
    expect(run.interrupt()).toBe(true);
    expect(run.interrupt()).toBe(false);
    await active;
    const first = run.close();
    expect(run.close()).toBe(first);
    await first;
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("joins a failed operation without turning close into a second error channel", async () => {
    const run = new ActiveAgentRun();
    const operation = run.run(async () => {
      throw new Error("run failed");
    });
    await expect(operation).rejects.toThrow("run failed");
    await expect(run.close()).resolves.toBeUndefined();
  });
});
