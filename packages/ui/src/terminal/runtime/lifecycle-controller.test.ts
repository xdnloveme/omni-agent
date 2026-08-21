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
});
