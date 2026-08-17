import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InlineTextInput } from "./inline-text-input";

describe("InlineTextInput", () => {
  it("renders the cursor in the interaction card and submits its own text", () => {
    const input = new InlineTextInput({
      title: "City — Custom answer",
      placeholder: "Type a city",
      dismissLabel: "Skip",
    });
    input.focused = true;
    input.onSubmit = vi.fn();

    input.handleInput("北京");
    const activeOutput = input.render(80).join("\n");
    expect(activeOutput).toContain(CURSOR_MARKER);
    expect(stripVTControlCharacters(activeOutput)).toContain("北京");

    input.handleInput("\r");
    expect(input.onSubmit).toHaveBeenCalledWith("北京");

    input.complete("北京");
    const resolvedOutput = stripVTControlCharacters(input.render(80).join("\n"));
    expect(resolvedOutput).toContain("City — Custom answer");
    expect(resolvedOutput).toContain("北京");
    expect(resolvedOutput).not.toContain("Type a city");
  });

  it("rejects empty required input and permits explicitly optional input", () => {
    const required = new InlineTextInput({ title: "Required" });
    required.onSubmit = vi.fn();
    required.handleInput("\r");
    expect(required.onSubmit).not.toHaveBeenCalled();

    const optional = new InlineTextInput({ title: "Optional", acceptsEmpty: true });
    optional.onSubmit = vi.fn();
    optional.handleInput("\r");
    expect(optional.onSubmit).toHaveBeenCalledWith("");
  });

  it("cancels on Escape", () => {
    const input = new InlineTextInput({ title: "Custom answer" });
    input.onCancel = vi.fn();
    input.handleInput("\x1b");
    expect(input.onCancel).toHaveBeenCalledOnce();
  });
});
