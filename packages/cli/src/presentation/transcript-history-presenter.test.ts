import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "@omni-agent/core";
import { TranscriptHistoryPresenter } from "./transcript-history-presenter";

describe("TranscriptHistoryPresenter", () => {
  it("renders complete recent turns through the existing message view models", () => {
    const presenter = new TranscriptHistoryPresenter(2);
    const view = presenter.present(transcript(), 2);

    expect(view.hiddenTurnCount).toBe(1);
    expect(view.loadEarlierLabel).toBe("↑ 1 earlier turn · Load 1 earlier");
    expect(view.resumedDivider).toBe("──────── Session resumed ────────");
    expect(view.entries[0]).toEqual({ type: "user", text: "run checks" });

    const run = view.entries.find((entry) => entry.type === "run");
    if (run?.type !== "run") throw new Error("run missing");
    const thinking = run.run.processNodes.find(
      (node) => node.kind === "disclosure" && node.disclosure.title === "Thinking",
    );
    expect(thinking).toMatchObject({
      disclosure: { state: "completed", initiallyExpanded: false, tone: "neutral" },
    });

    const toolBatch = run.run.processNodes.find(
      (node) => node.kind === "disclosure" && node.disclosure.title === "Tool Calls",
    );
    expect(toolBatch).toMatchObject({
      disclosure: { state: "completed", summary: "2/2 completed" },
    });
    if (toolBatch?.kind !== "disclosure") throw new Error("tool batch missing");
    expect(toolBatch.disclosure.summary).not.toContain("ms");
    expect(toolBatch.disclosure.children?.map((child) => child.title)).toEqual([
      "bash",
      "file_read",
    ]);
    expect(toolBatch.disclosure.children?.[0]?.details()).toContain("output:");

    expect(view.entries.at(-2)).toEqual({ type: "user", text: "summarize" });
    expect(view.entries.at(-1)).toMatchObject({
      type: "run",
      run: {
        finalNode: { markdown: "All checks passed." },
      },
    });
  });

  it("loads earlier history by complete user turns", () => {
    const presenter = new TranscriptHistoryPresenter(2);
    const view = presenter.present(transcript(), 4);

    expect(view.hiddenTurnCount).toBe(0);
    expect(view.loadEarlierLabel).toBeUndefined();
    expect(view.entries[0]).toEqual({ type: "user", text: "first question" });
    expect(
      view.entries.some(
        (entry) =>
          entry.type === "run" && entry.run.processNodes.some((node) => node.kind === "disclosure"),
      ),
    ).toBe(true);
  });

  it("keeps failed historical tool calls folded", () => {
    const presenter = new TranscriptHistoryPresenter();
    const view = presenter.present(
      [
        user("run", 1),
        assistant(
          [
            {
              type: "toolCall",
              id: "failed-call",
              name: "bash",
              arguments: { command: "false" },
            },
          ],
          2,
          "toolUse",
        ),
        toolResult("failed-call", "bash", "failed", true, 3),
      ],
      10,
    );
    const run = view.entries.find((entry) => entry.type === "run");
    const disclosure =
      run?.type === "run"
        ? run.run.processNodes.find((node) => node.kind === "disclosure")
        : undefined;

    expect(disclosure).toMatchObject({
      disclosure: { state: "failed", initiallyExpanded: false },
    });
  });
});

function transcript(): TranscriptMessage[] {
  return [
    user("first question", 1),
    assistant([{ type: "text", text: "first answer" }], 2),
    user("run checks", 3),
    assistant(
      [
        { type: "thinking", thinking: "checking the repository" },
        { type: "thinking", thinking: "", redacted: true },
        { type: "text", text: "I will run the checks." },
        { type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "pnpm test" } },
        {
          type: "toolCall",
          id: "read-call",
          name: "file_read",
          arguments: { file_path: "package.json" },
        },
      ],
      4,
      "toolUse",
    ),
    toolResult("bash-call", "bash", "passed", false, 5),
    toolResult("read-call", "file_read", "{}", false, 6),
    assistant([{ type: "text", text: "Checks completed." }], 7),
    user("summarize", 8),
    assistant([{ type: "text", text: "All checks passed." }], 9),
  ];
}

function user(content: string, timestamp: number): TranscriptMessage {
  return { role: "user", content, timestamp };
}

function assistant(
  content: Extract<TranscriptMessage, { role: "assistant" }>["content"],
  timestamp: number,
  stopReason: Extract<TranscriptMessage, { role: "assistant" }>["stopReason"] = "stop",
): TranscriptMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    stopReason,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    timestamp,
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean,
  timestamp: number,
): TranscriptMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp,
  };
}
