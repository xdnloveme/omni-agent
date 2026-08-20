import { describe, expect, it, vi } from "vitest";
import {
  CompositeRuntimeObserver,
  NOOP_RUNTIME_OBSERVER,
  NOOP_RUNTIME_TURN_OBSERVATION,
  RuntimeObservationTerminal,
  iterateObserved,
} from "../runtime-observation";
import { RecordingRuntimeObserver } from "../testing/runtime-observation";

describe("Runtime Observation", () => {
  it("keeps the Noop path transparent", async () => {
    const run = NOOP_RUNTIME_OBSERVER.startRun({
      agentId: "test",
      sessionId: "session",
      runId: "run",
    });
    expect(run.run(() => 42)).toBe(42);
    expect(() =>
      run.run(() => {
        throw new Error("original");
      }),
    ).toThrow("original");
  });

  it("isolates a failing Composite child and preserves healthy consumers", () => {
    const healthy = new RecordingRuntimeObserver();
    const diagnostics: string[] = [];
    const composite = new CompositeRuntimeObserver(
      [
        {
          startRun() {
            throw new Error("failed observer");
          },
        },
        healthy,
      ],
      (diagnostic) => diagnostics.push(diagnostic.message),
    );

    const run = composite.startRun({
      agentId: "test",
      sessionId: "session",
      runId: "run",
    });
    run.startTurn({ turn: 0 }).complete({ turn: 0 });
    run.complete({});

    expect(healthy.records.map((record) => record.operation)).toEqual([
      "run.started",
      "turn.started",
      "turn.completed",
      "run.completed",
    ]);
    expect(diagnostics).toEqual(["failed observer"]);
  });

  it("accepts only the first terminal transition", () => {
    const complete = vi.fn();
    const fail = vi.fn();
    const observer = {
      startRun() {
        return {
          run: <T>(operation: () => T) => operation(),
          userInput() {},
          startOperation() {
            throw new Error("unused");
          },
          startTurn: () => ({ ...NOOP_RUNTIME_TURN_OBSERVATION, complete, fail }),
          complete() {},
          fail() {},
          cancel() {},
        };
      },
    };
    const turn = new CompositeRuntimeObserver([observer])
      .startRun({ agentId: "test", sessionId: "session", runId: "run" })
      .startTurn({ turn: 0 });

    turn.complete({ turn: 0 });
    turn.fail({
      turn: 0,
      failure: { code: "late", message: "late", retryable: false },
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it("rejects child events after a scope reaches its terminal state", () => {
    const diagnostics: string[] = [];
    const recorder = new RecordingRuntimeObserver();
    const run = new CompositeRuntimeObserver([recorder], (diagnostic) =>
      diagnostics.push(diagnostic.message),
    ).startRun({ agentId: "test", sessionId: "session", runId: "run" });
    const turn = run.startTurn({ turn: 0 });
    turn.complete({ turn: 0 });

    turn.finalResponse({ modelCallId: "late-model" });
    turn.startToolBatch({
      batch: { batchId: "late-batch", modelCallId: "late-model", members: [] },
    });

    expect(recorder.records.map((record) => record.operation)).not.toContain(
      "agent.final_response",
    );
    expect(diagnostics).toEqual([
      "Runtime observation scope is already terminal: turn",
      "Runtime observation scope is already terminal: turn",
    ]);
  });

  it("isolates a Composite scope context failure without repeating the operation", () => {
    let operations = 0;
    const healthy = new RecordingRuntimeObserver();
    const failing = {
      startRun() {
        return {
          ...NOOP_RUNTIME_OBSERVER.startRun({
            agentId: "test",
            sessionId: "session",
            runId: "run",
          }),
          run<T>(): T {
            throw new Error("context failed");
          },
        };
      },
    };
    const run = new CompositeRuntimeObserver([failing, healthy]).startRun({
      agentId: "test",
      sessionId: "session",
      runId: "run",
    });

    expect(
      run.run(() => {
        operations += 1;
        return 42;
      }),
    ).toBe(42);
    expect(operations).toBe(1);
  });

  it("preserves undefined throws and rejects observer control over operations", () => {
    const diagnostics: string[] = [];
    const baseRun = NOOP_RUNTIME_OBSERVER.startRun({
      agentId: "test",
      sessionId: "session",
      runId: "run",
    });
    const suppressing = {
      startRun() {
        return { ...baseRun, run: <T>(): T => 99 as T };
      },
    };
    const replacing = {
      startRun() {
        return {
          ...baseRun,
          run<T>(operation: () => T): T {
            operation();
            return 99 as T;
          },
        };
      },
    };
    const repeating = {
      startRun() {
        return {
          ...baseRun,
          run<T>(operation: () => T): T {
            const result = operation();
            operation();
            return result;
          },
        };
      },
    };
    const run = new CompositeRuntimeObserver([suppressing, replacing, repeating], (diagnostic) =>
      diagnostics.push(diagnostic.message),
    ).startRun({ agentId: "test", sessionId: "session", runId: "run" });
    let operations = 0;

    expect(
      run.run(() => {
        operations += 1;
        return 42;
      }),
    ).toBe(42);
    expect(operations).toBe(1);
    expect(diagnostics).toEqual([
      "Runtime observer did not invoke the operation",
      "Runtime observer invoked the operation more than once",
      "Runtime observer changed the operation result",
    ]);

    let caught = false;
    try {
      new CompositeRuntimeObserver([replacing])
        .startRun({
          agentId: "test",
          sessionId: "session",
          runId: "run",
        })
        .run(() => {
          throw undefined;
        });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);

    const original = new Error("original");
    const swallowing = {
      startRun() {
        return {
          ...baseRun,
          run<T>(operation: () => T): T {
            try {
              return operation();
            } catch {
              return 99 as T;
            }
          },
        };
      },
    };
    expect(() =>
      new CompositeRuntimeObserver([swallowing])
        .startRun({ agentId: "test", sessionId: "session", runId: "run" })
        .run(() => {
          throw original;
        }),
    ).toThrow(original);
  });

  it("rejects observer callbacks invoked after their scope returns", () => {
    const diagnostics: string[] = [];
    const baseRun = NOOP_RUNTIME_OBSERVER.startRun({
      agentId: "test",
      sessionId: "session",
      runId: "run",
    });
    let delayed: (() => unknown) | undefined;
    const observer = {
      startRun() {
        return {
          ...baseRun,
          run<T>(operation: () => T): T {
            delayed = operation;
            return undefined as T;
          },
        };
      },
    };
    const run = new CompositeRuntimeObserver([observer], (diagnostic) =>
      diagnostics.push(diagnostic.message),
    ).startRun({ agentId: "test", sessionId: "session", runId: "run" });
    let operations = 0;

    expect(
      run.run(() => {
        operations += 1;
        return 42;
      }),
    ).toBe(42);
    expect(operations).toBe(1);

    delayed?.();

    expect(operations).toBe(1);
    expect(diagnostics).toEqual([
      "Runtime observer did not invoke the operation",
      "Runtime observer invoked the operation after its scope returned",
    ]);
  });

  it("forwards iterator next, throw, and return inside scope context", async () => {
    const calls: string[] = [];
    const scope = {
      run<T>(operation: () => T): T {
        calls.push("run");
        return operation();
      },
    };
    let next = 0;
    const source = {
      next: vi.fn(async () =>
        next++ === 0 ? { value: 1, done: false as const } : { value: 2, done: false as const },
      ),
      throw: vi.fn(async () => ({ value: 3, done: false as const })),
      return: vi.fn(async (value?: string | PromiseLike<string>) => ({
        value: (await value) ?? "",
        done: true as const,
      })),
    };

    const iterator = iterateObserved<number, string, unknown>(scope, () => source);
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.throw(new Error("consumer"))).resolves.toEqual({
      value: 3,
      done: false,
    });
    await expect(iterator.return("consumer")).resolves.toEqual({
      value: "consumer",
      done: true,
    });

    expect(source.next).toHaveBeenCalledOnce();
    expect(source.throw).toHaveBeenCalledOnce();
    expect(source.return).toHaveBeenCalledWith("consumer");
    expect(calls).toHaveLength(4);
  });

  it("isolates terminal callback and diagnostic failures", () => {
    const diagnostics: string[] = [];
    const terminal = new RuntimeObservationTerminal("test", (diagnostic) => {
      diagnostics.push(diagnostic.message);
    });
    expect(() =>
      terminal.finish("complete", () => {
        throw new Error("terminal failed");
      }),
    ).not.toThrow();
    expect(diagnostics).toEqual(["terminal failed"]);

    const failingDiagnosticTerminal = new RuntimeObservationTerminal("test", () => {
      throw new Error("diagnostic failed");
    });
    expect(() =>
      failingDiagnosticTerminal.finish("complete", () => {
        throw new Error("terminal failed");
      }),
    ).not.toThrow();
  });
});
