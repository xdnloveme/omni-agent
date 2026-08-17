import { describe, expect, it, vi } from "vitest";
import { InlineMultiSelect } from "./inline-multi-select";

describe("InlineMultiSelect", () => {
  it("toggles choices and submits the selected ids", () => {
    const component = new InlineMultiSelect({
      title: "Features",
      items: [
        { value: "search", label: "Search" },
        { value: "export", label: "Export" },
      ],
    });
    component.onSubmit = vi.fn();
    component.handleInput(" ");
    component.handleInput("\x1b[B");
    component.handleInput(" ");
    component.handleInput("\r");
    expect(component.onSubmit).toHaveBeenCalledWith(["search", "export"]);
  });

  it("cancels on Escape", () => {
    const component = new InlineMultiSelect({
      title: "Features",
      items: [{ value: "search", label: "Search" }],
    });
    component.onCancel = vi.fn();
    component.handleInput("\x1b");
    expect(component.onCancel).toHaveBeenCalledOnce();
  });

  it("maps clicks through rendered option rows", () => {
    const component = new InlineMultiSelect({
      title: "Features",
      detail: "Choose several",
      message: "Required for generation",
      items: [
        { value: "search", label: "Search" },
        { value: "export", label: "Export" },
      ],
    });
    component.render(80);
    component.handleClick(5);
    component.onSubmit = vi.fn();
    component.handleInput("\r");
    expect(component.onSubmit).toHaveBeenCalledWith(["export"]);
  });
});
