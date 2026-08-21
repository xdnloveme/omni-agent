import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { InlineSelect } from "./inline-select";

const options = {
  title: "Permission required",
  detail: "Run shell command",
  message: "Risk: execute",
  items: [
    { value: "once", label: "Allow once" },
    { value: "deny", label: "Deny" },
  ],
};

describe("InlineSelect", () => {
  it("selects with the keyboard and keeps the result in the message flow", () => {
    const selection = new InlineSelect(options);
    const onSelect = vi.fn();
    selection.onSelect = onSelect;

    selection.handleInput("\x1b[B");
    selection.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("deny");

    selection.resolve("deny");
    const output = stripVTControlCharacters(selection.render(80).join("\n"));
    expect(output).toContain("Permission required");
    expect(output).toContain("Deny");
    expect(output).not.toContain("Allow once");
  });

  it("selects an option by clicking its rendered row", () => {
    const selection = new InlineSelect(options);
    const onSelect = vi.fn();
    selection.onSelect = onSelect;
    const lines = selection.render(80).map(stripVTControlCharacters);
    const denyRow = lines.findIndex((line) => line.includes("Deny"));

    selection.handleClick(denyRow);
    expect(onSelect).toHaveBeenCalledWith("deny");
  });

  it("renders an action banner for permission-style selections", () => {
    const selection = new InlineSelect({ ...options, tone: "warning" });
    const output = stripVTControlCharacters(selection.render(80).join("\n"));

    expect(output).toContain("⚠ ACTION REQUIRED");
    expect(output).toContain("[ Allow once ]");
  });

  it("renders options as internal links when a link factory is provided", () => {
    const selection = new InlineSelect(
      options,
      (value) => `omni-agent://select/selection-1/${value}`,
    );
    const output = selection.render(80).join("\n");

    expect(output).toContain("omni-agent://select/selection-1/once");
    expect(output).toContain("omni-agent://select/selection-1/deny");
  });
});
