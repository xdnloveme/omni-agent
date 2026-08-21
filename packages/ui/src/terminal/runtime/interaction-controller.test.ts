import { Container, type Editor, type TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createTuiInteractionController } from "./interaction-controller";

function fixture() {
  const ui = {
    setFocus: vi.fn(),
    requestRender: vi.fn(),
  } as unknown as TuiAltScreen;
  const editor = {} as Editor;
  const internalLinks = new Map<string, () => void>();
  const controller = createTuiInteractionController({
    ui,
    editor,
    messageBody: new Container(),
    internalLinks,
    line: vi.fn(),
  });
  return { controller, editor, internalLinks, ui };
}

const selection = {
  title: "Choose",
  items: [
    { value: "one", label: "One" },
    { value: "two", label: "Two" },
  ],
};

describe("TUI interaction controller", () => {
  it("preserves Escape settlement and restores editor focus", async () => {
    const { controller, editor, internalLinks, ui } = fixture();
    const result = controller.select(selection);

    expect(controller.active).toBe(true);
    expect(controller.escape()).toBe(true);
    await expect(result).resolves.toEqual({ kind: "escape" });

    expect(controller.active).toBe(false);
    expect(internalLinks.size).toBe(0);
    expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
  });

  it("maps AbortSignal cancellation and shutdown to their existing result kinds", async () => {
    const aborted = fixture();
    const abort = new AbortController();
    const abortedResult = aborted.controller.select(selection, abort.signal);
    abort.abort();
    await expect(abortedResult).resolves.toMatchObject({
      kind: "abort",
      error: { name: "AbortError" },
    });

    const shuttingDown = fixture();
    const shutdownResult = shuttingDown.controller.select(selection);
    shuttingDown.controller.shutdown();
    await expect(shutdownResult).resolves.toMatchObject({
      kind: "shutdown",
      error: { name: "AbortError" },
    });
  });

  it("keeps one active interaction at a time", async () => {
    const { controller } = fixture();
    const active = controller.select(selection);

    await expect(controller.select(selection)).rejects.toThrow("A selection is already active");
    controller.escape();
    await expect(active).resolves.toEqual({ kind: "escape" });
  });
});
