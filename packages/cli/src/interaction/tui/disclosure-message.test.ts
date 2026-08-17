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

  it("collapses a streaming disclosure when it completes", () => {
    const message = new DisclosureMessage(
      {
        id: "thinking:1",
        title: "Thinking",
        state: "running",
        tone: "neutral",
        details: () => ["reasoning"],
        initiallyExpanded: true,
        collapseOnComplete: true,
      },
      "omni-agent://disclosure/thinking%3A1",
    );
    expect(message.render(80).join("\n")).toContain("reasoning");

    message.update({
      id: "thinking:1",
      title: "Thinking",
      state: "completed",
      tone: "neutral",
      details: () => ["reasoning"],
      initiallyExpanded: false,
      collapseOnComplete: true,
    });
    expect(message.render(80).join("\n")).not.toContain("reasoning");
  });

  it("renders nested disclosures and toggles a child independently", () => {
    const message = new DisclosureMessage(
      {
        id: "tool-batch:1",
        title: "Tools",
        state: "completed",
        tone: "success",
        details: () => [],
        initiallyExpanded: true,
        children: [
          {
            id: "tool:1",
            title: "bash",
            state: "completed",
            tone: "success",
            details: () => ["output: passed"],
            initiallyExpanded: false,
          },
        ],
      },
      "omni-agent://disclosure/tool-batch%3A1",
    );

    expect(message.render(100).join("\n")).toContain("bash");
    expect(message.render(100).join("\n")).not.toContain("output: passed");
    expect(message.toggle("tool:1")).toBe(true);
    expect(message.render(100).join("\n")).toContain("output: passed");
  });

  it("preserves a child detail cache when only its parent batch changes", () => {
    const details = vi.fn(() => ["cached detail"]);
    const child = {
      id: "tool:1",
      title: "bash",
      state: "completed" as const,
      tone: "success" as const,
      details,
      initiallyExpanded: true,
    };
    const message = new DisclosureMessage(
      {
        id: "tool-batch:1",
        title: "Tools",
        summary: "1/2 done",
        state: "running",
        tone: "neutral",
        details: () => [],
        initiallyExpanded: true,
        children: [child],
      },
      "omni-agent://disclosure/tool-batch%3A1",
    );
    message.render(100);
    message.update({
      id: "tool-batch:1",
      title: "Tools",
      summary: "running next tool",
      state: "running",
      tone: "neutral",
      details: () => [],
      initiallyExpanded: true,
      children: [child],
    });
    message.render(100);

    expect(details).toHaveBeenCalledTimes(1);
  });
});
