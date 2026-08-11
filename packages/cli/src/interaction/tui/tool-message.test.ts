import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { ToolMessage } from "./tool-message";

function render(message: ToolMessage, width = 100): string {
  return stripVTControlCharacters(message.render(width).join("\n"));
}

describe("ToolMessage", () => {
  it("keeps successful tool output collapsed by default", () => {
    const message = new ToolMessage("file_read", { file_path: "README.md" });
    message.finish({ content: [{ type: "text", text: "hidden tool output" }], isError: false }, 42);

    const output = render(message);
    expect(output).toContain("▶ file_read");
    expect(output).toContain("README.md");
    expect(output).toContain("✓ done (42ms)");
    expect(output).not.toContain("hidden tool output");
  });

  it("shows input and result after expansion", () => {
    const message = new ToolMessage("bash", { command: "pnpm test" });
    message.finish({ content: [{ type: "text", text: "all tests passed" }], isError: false }, 125);

    const output = render(message);
    expect(output).toContain("▼ bash");
    expect(output).toContain('input: {"command":"pnpm test"}');
    expect(output).toContain("output:");
    expect(output).toContain("all tests passed");
  });

  it("previews a result and then collapses it", () => {
    const message = new ToolMessage("bash", { command: "pnpm test" });
    expect(
      message.finish({ content: [{ type: "text", text: "previewed result" }], isError: false }, 5),
    ).toBe(true);

    expect(render(message)).toContain("previewed result");
    message.collapsePreview();
    expect(render(message)).not.toContain("previewed result");
  });

  it("toggles collapsed details from an internal link callback", () => {
    const message = new ToolMessage(
      "file_read",
      { file_path: "README.md" },
      "omni-agent://tool/call-1",
    );
    message.finish({ content: [{ type: "text", text: "linked detail" }], isError: false }, 5);

    expect(message.render(100).join("\n")).toContain("omni-agent://tool/call-1");
    message.toggleDetails();
    expect(render(message)).toContain("linked detail");
    message.toggleDetails();
    expect(render(message)).not.toContain("linked detail");
  });

  it("bounds expanded output", () => {
    const message = new ToolMessage("grep", { regex: "large result" });
    message.finish(
      {
        content: [
          { type: "text", text: Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n") },
        ],
        isError: false,
      },
      1,
    );

    const output = render(message, 200);
    expect(output).toContain("output truncated");
    expect(output).toContain("50 more lines");
    expect(output).not.toContain("line 249");
  });
});
