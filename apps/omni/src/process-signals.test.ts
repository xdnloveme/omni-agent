import { describe, expect, it, vi } from "vitest";
import { ProcessSignalSupervisor, ProcessTerminationController } from "./process-signals";

describe("ProcessTerminationController", () => {
  it("broadcasts the first termination and aborts active host interactions", () => {
    const controller = new ProcessTerminationController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.terminate({ kind: "signal", signal: "SIGTERM" });
    controller.terminate({ kind: "user_interrupt" });

    expect(controller.signal.aborted).toBe(true);
    expect(controller.current).toEqual({ kind: "signal", signal: "SIGTERM" });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ kind: "signal", signal: "SIGTERM" });
  });

  it("delivers an earlier termination to late lifecycle subscribers", () => {
    const controller = new ProcessTerminationController();
    const listener = vi.fn();
    controller.terminate({ kind: "user_interrupt" });

    const unsubscribe = controller.subscribe(listener);
    unsubscribe();

    expect(listener).toHaveBeenCalledExactlyOnceWith({ kind: "user_interrupt" });
  });

  it("allows a lifecycle owner to unsubscribe before termination", () => {
    const controller = new ProcessTerminationController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();

    controller.terminate({ kind: "completed" });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ProcessSignalSupervisor", () => {
  it("allows graceful shutdown to complete before its deadline", () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const forceExit = vi.fn();
    const supervisor = new ProcessSignalSupervisor({
      gracefulShutdownMs: 5_000,
      terminate,
      forceExit,
    });

    supervisor.handle("SIGTERM", { kind: "signal", signal: "SIGTERM" });
    supervisor.dispose();
    vi.runAllTimers();

    expect(terminate).toHaveBeenCalledExactlyOnceWith({ kind: "signal", signal: "SIGTERM" });
    expect(forceExit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("restores OS signal termination after the graceful deadline", () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const supervisor = new ProcessSignalSupervisor({
      gracefulShutdownMs: 5_000,
      terminate: vi.fn(),
      forceExit,
    });

    supervisor.handle("SIGTERM", { kind: "signal", signal: "SIGTERM" });
    vi.advanceTimersByTime(5_000);

    expect(forceExit).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.useRealTimers();
  });

  it("forces an immediate exit when the same process receives another signal", () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const supervisor = new ProcessSignalSupervisor({
      gracefulShutdownMs: 5_000,
      terminate: vi.fn(),
      forceExit,
    });

    supervisor.handle("SIGINT", { kind: "user_interrupt" });
    supervisor.handle("SIGTERM", { kind: "signal", signal: "SIGTERM" });

    expect(forceExit).toHaveBeenCalledExactlyOnceWith("SIGINT");
    vi.useRealTimers();
  });
});

describe("signal diagnostics", () => {
  it("distinguishes a second signal from deadline expiry", () => {
    vi.useFakeTimers();
    try {
      const events: unknown[] = [];
      const supervisor = new ProcessSignalSupervisor({
        gracefulShutdownMs: 5,
        terminate: vi.fn(),
        forceExit: vi.fn(),
        onDiagnostic: (e) => events.push(e),
      });
      supervisor.handle("SIGTERM", { kind: "signal", signal: "SIGTERM" });
      vi.advanceTimersByTime(5);
      expect(events).toEqual([
        { type: "signal_received", signal: "SIGTERM", repeated: false },
        { type: "force_exit", signal: "SIGTERM", reason: "deadline" },
      ]);
      events.length = 0;
      supervisor.handle("SIGTERM", { kind: "signal", signal: "SIGTERM" });
      supervisor.handle("SIGINT", { kind: "user_interrupt" });
      expect(events.at(-1)).toEqual({
        type: "force_exit",
        signal: "SIGTERM",
        reason: "repeat_signal",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("still terminates when diagnostic reporting throws", () => {
    const forceExit = vi.fn();
    const supervisor = new ProcessSignalSupervisor({
      gracefulShutdownMs: 5000,
      terminate: vi.fn(),
      forceExit,
      onDiagnostic: () => {
        throw new Error("sink failed");
      },
    });
    supervisor.handle("SIGTERM", { kind: "signal", signal: "SIGTERM" });
    supervisor.handle("SIGINT", { kind: "user_interrupt" });
    expect(forceExit).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });
});
