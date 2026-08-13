import { describe, expect, it, vi } from "vitest";
import { DisclosureMessage } from "./disclosure-message";

describe("DisclosureMessage", () => {
  it("does not build details until first expansion and caches them", () => {
    const details = vi.fn(() => ["detail"]);
    const message = new DisclosureMessage(
      {
        id: "tool:1",
        title: "file_read",
        summary: "/workspace/a.ts",
        state: "completed",
        tone: "success",
        details,
        initiallyExpanded: false,
      },
      "omni-agent://disclosure/tool%3A1",
    );

    message.render(100);
    expect(details).not.toHaveBeenCalled();
    message.toggle();
    message.render(100);
    message.render(100);
    expect(details).toHaveBeenCalledTimes(1);
  });

  it("renders state text independently of color", () => {
    const message = new DisclosureMessage(
      {
        id: "compression:1",
        title: "Context compression",
        state: "failed",
        tone: "error",
        details: () => ["reason: invalid summary"],
        initiallyExpanded: true,
      },
      "omni-agent://disclosure/compression%3A1",
    );

    expect(message.render(80).join("\n")).toContain("error");
    expect(message.render(80).join("\n")).toContain("invalid summary");
  });

  it("renders elapsed seconds for a running disclosure", () => {
    let now = 1_000;
    const message = new DisclosureMessage(
      {
        id: "tool:1",
        title: "bash",
        state: "running",
        startedAt: 1_000,
        tone: "neutral",
        details: () => [],
        initiallyExpanded: false,
      },
      "omni-agent://disclosure/tool%3A1",
      () => now,
    );

    expect(message.render(80).join("\n")).toContain("running…");
    expect(message.render(80).join("\n")).not.toContain("0s");
    now = 4_200;
    expect(message.render(80).join("\n")).toContain("running… 3s");
  });
});
