import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { RunPresentationViewModel } from "../../presentation/view-models";
import { RunMessage } from "./run-message";

type FinalNode = NonNullable<RunPresentationViewModel["finalNode"]>;

const theme = new Proxy(
  {},
  {
    get: (_target, property) => (property === "codeBlockIndent" ? "  " : (value: string) => value),
  },
) as MarkdownTheme;

function viewModel(overrides: Partial<RunPresentationViewModel> = {}): RunPresentationViewModel {
  return {
    id: "run",
    processNodes: [{ id: "process", kind: "plain", text: "process output" }],
    state: "running",
    startedAt: 0,
    ...overrides,
  };
}

function finalNode(overrides: Partial<FinalNode> = {}): FinalNode {
  return {
    id: "final",
    kind: "text",
    modelCallId: "call",
    textSegmentId: "call:text:0",
    markdown: "final answer",
    ...overrides,
  };
}

describe("RunMessage", () => {
  it("shows process content while running and auto-collapses when final appears", () => {
    const message = new RunMessage(viewModel(), theme, "omni-agent://run", () => 2_000);
    expect(message.render(80).join("\n")).toContain("process output");

    message.update(
      viewModel({
        finalNode: finalNode(),
      }),
    );

    const rendered = message.render(80).join("\n");
    expect(rendered).not.toContain("process output");
    expect(rendered).toContain("final answer");
  });

  it("does not collapse again after the user expands the process", () => {
    const message = new RunMessage(
      viewModel({
        finalNode: finalNode(),
      }),
      theme,
      "omni-agent://run",
      () => 2_000,
    );
    expect(message.toggle("run")).toBe(true);
    message.update(
      viewModel({
        finalNode: finalNode(),
        metrics: { full: "metrics", compact: "metrics", minimal: "metrics", usagePercent: 10 },
      }),
    );

    expect(message.render(80).join("\n")).toContain("process output");
  });

  it("keeps final text and metrics visible across responsive widths", () => {
    const message = new RunMessage(
      viewModel({
        finalNode: finalNode(),
        metrics: {
          full: "full metrics",
          compact: "compact metrics",
          minimal: "minimal metrics",
          usagePercent: 10,
        },
      }),
      theme,
      "omni-agent://run",
      () => 2_000,
    );

    expect(message.render(100).join("\n")).toContain("full metrics");
    const narrow = message.render(40).join("\n");
    expect(narrow).toContain("final answer");
    expect(narrow).toContain("minimal metrics");
  });
});
