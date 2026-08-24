import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { InlineSelect } from "./inline-select";

const options = {
  title: "Choose deployment",
  detail: "Select one target",
  message: "The choice takes effect immediately",
  items: [
    { value: "preview", label: "Preview" },
    { value: "production", label: "Production" },
  ],
};

describe("InlineSelect", () => {
  it("selects with the keyboard and keeps the result in the message flow", () => {
    const selection = new InlineSelect(options);
    const onSelect = vi.fn();
    selection.onSelect = onSelect;

    selection.handleInput("\x1b[B");
    selection.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("production");

    selection.resolve("production");
    const output = stripVTControlCharacters(selection.render(80).join("\n"));
    expect(output).toContain("Choose deployment");
    expect(output).toContain("Production");
    expect(output).not.toContain("Preview");
  });

  it("selects an option by clicking its rendered row", () => {
    const selection = new InlineSelect(options);
    const onSelect = vi.fn();
    selection.onSelect = onSelect;
    const lines = selection.render(80).map(stripVTControlCharacters);
    const productionRow = lines.findIndex((line) => line.includes("Production"));

    selection.handleClick(productionRow);
    expect(onSelect).toHaveBeenCalledWith("production");
  });

  it("renders an action banner for warning selections", () => {
    const selection = new InlineSelect({ ...options, tone: "warning" });
    const output = stripVTControlCharacters(selection.render(80).join("\n"));

    expect(output).toContain("⚠ ACTION REQUIRED");
    expect(output).toContain("[ Preview ]");
  });

  it("renders options as internal links when a link factory is provided", () => {
    const selection = new InlineSelect(
      options,
      (value) => `omni-agent://select/selection-1/${value}`,
    );
    const output = selection.render(80).join("\n");

    expect(output).toContain("omni-agent://select/selection-1/preview");
    expect(output).toContain("omni-agent://select/selection-1/production");
  });
});
