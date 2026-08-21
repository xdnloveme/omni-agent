import type { Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createTuiLifecycleController } from "./lifecycle-controller";

describe("TUI lifecycle controller", () => {
  it("preserves initial render, pause/resume, and idempotent shutdown ordering", async () => {
    const ui = {
      start: vi.fn(),
      stop: vi.fn(),
      renderNow: vi.fn(),
      requestRender: vi.fn(),
    } as unknown as TuiAltScreen;
    const statusLine = { setText: vi.fn() } as unknown as Text;
    const release = vi.fn();
    const lifecycle = createTuiLifecycleController({
      ui,
      statusLine,
      initialStatus: "ready",
      release,
    });

    const termination = lifecycle.start();
    expect(statusLine.setText).toHaveBeenCalledExactlyOnceWith("ready");
    expect(ui.start).toHaveBeenCalledOnce();
    expect(ui.renderNow).toHaveBeenCalledExactlyOnceWith(true);

    lifecycle.pause();
    lifecycle.resume();
    expect(ui.start).toHaveBeenCalledTimes(2);
    expect(ui.requestRender).toHaveBeenCalledExactlyOnceWith(true);

    lifecycle.shutdown({ kind: "user_interrupt" });
    lifecycle.shutdown();
    await expect(termination).resolves.toEqual({ kind: "user_interrupt" });
    expect(release).toHaveBeenCalledOnce();
    expect(ui.stop).toHaveBeenCalledTimes(2);
  });

  it("preserves a shutdown that arrives before start without starting the UI", async () => {
    const ui = {
      start: vi.fn(),
      stop: vi.fn(),
      renderNow: vi.fn(),
      requestRender: vi.fn(),
    } as unknown as TuiAltScreen;
    const statusLine = { setText: vi.fn() } as unknown as Text;
    const release = vi.fn();
    const lifecycle = createTuiLifecycleController({
      ui,
      statusLine,
      initialStatus: "ready",
      release,
    });

    lifecycle.shutdown({ kind: "signal", signal: "SIGTERM" });

    await expect(lifecycle.start()).resolves.toEqual({ kind: "signal", signal: "SIGTERM" });
    lifecycle.pause();
    lifecycle.resume();
    lifecycle.shutdown();

    expect(release).toHaveBeenCalledOnce();
    expect(statusLine.setText).not.toHaveBeenCalled();
    expect(ui.start).not.toHaveBeenCalled();
    expect(ui.stop).not.toHaveBeenCalled();
    expect(ui.renderNow).not.toHaveBeenCalled();
    expect(ui.requestRender).not.toHaveBeenCalled();
  });

  it("returns the same completion when start is called more than once", async () => {
    const ui = {
      start: vi.fn(),
      stop: vi.fn(),
      renderNow: vi.fn(),
      requestRender: vi.fn(),
    } as unknown as TuiAltScreen;
    const lifecycle = createTuiLifecycleController({
      ui,
      statusLine: { setText: vi.fn() } as unknown as Text,
      initialStatus: "ready",
      release: vi.fn(),
    });

    const first = lifecycle.start();
    const second = lifecycle.start();
    lifecycle.shutdown();

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ kind: "completed" });
    expect(ui.start).toHaveBeenCalledOnce();
  });
});
