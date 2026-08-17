import {
  type ToolCallContent,
  type ToolResultTranscriptMessage,
  type TranscriptMessage,
} from "@omni-agent/core";
import { ThinkingPresenter } from "./thinking-presenter";
import { ToolBatchPresenter, type RestoredToolInvocation } from "./tool-batch-presenter";
import type { SessionHistoryViewModel } from "./view-models";

interface IndexedMessage {
  readonly index: number;
  readonly message: TranscriptMessage;
}

export class TranscriptHistoryPresenter {
  private readonly thinking = new ThinkingPresenter();
  private readonly tools = new ToolBatchPresenter();

  constructor(private readonly pageSize: number = 10) {}

  present(
    messages: readonly TranscriptMessage[],
    visibleTurnCount: number,
  ): SessionHistoryViewModel {
    const indexed = messages.map((message, index) => ({ index, message }));
    const turns = groupConversationTurns(indexed);
    const effectiveVisibleTurnCount = Math.max(1, visibleTurnCount);
    const visible = turns.slice(-effectiveVisibleTurnCount).flat();
    const hiddenTurnCount = Math.max(0, turns.length - effectiveVisibleTurnCount);
    const results = new Map(
      messages
        .filter((message): message is ToolResultTranscriptMessage => message.role === "toolResult")
        .map((message) => [message.toolCallId, message]),
    );
    const entries: SessionHistoryViewModel["entries"][number][] = [];

    for (const { index, message } of visible) {
      if (message.role === "user") {
        const text = userMessageText(message.content);
        if (text) entries.push({ type: "user", text });
        continue;
      }
      if (message.role === "toolResult") continue;

      const calls = message.content.filter(
        (block): block is ToolCallContent => block.type === "toolCall",
      );
      let toolBatchPresented = false;
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type === "text") {
          if (block.text) entries.push({ type: "assistant", markdown: block.text });
          continue;
        }
        if (block.type === "thinking") {
          if (block.redacted) continue;
          const disclosure = this.thinking.restore(
            `history:thinking:${index}:${contentIndex}`,
            block.thinking,
          );
          if (disclosure) entries.push({ type: "disclosure", disclosure });
          continue;
        }
        if (toolBatchPresented) continue;
        toolBatchPresented = true;
        const disclosure = this.restoreToolBatch(index, calls, results);
        if (disclosure) entries.push({ type: "disclosure", disclosure });
      }
    }

    return {
      entries,
      hiddenTurnCount,
      ...(hiddenTurnCount > 0
        ? {
            loadEarlierLabel: `↑ ${hiddenTurnCount} earlier turn${hiddenTurnCount === 1 ? "" : "s"} · Load ${Math.min(this.pageSize, hiddenTurnCount)} earlier`,
          }
        : {}),
      resumedDivider: "──────── Session resumed ────────",
    };
  }

  private restoreToolBatch(
    messageIndex: number,
    calls: readonly ToolCallContent[],
    results: ReadonlyMap<string, ToolResultTranscriptMessage>,
  ) {
    const modelCallId = `history:model:${messageIndex}`;
    const descriptor = {
      batchId: `history:batch:${messageIndex}`,
      modelCallId,
      members: calls.map((call) => ({
        toolName: call.name,
        toolCallId: call.id,
        preview: { action: "invoke" as const },
      })),
    };
    const invocations: RestoredToolInvocation[] = calls.map((call, index) => {
      const result = results.get(call.id);
      return {
        toolName: call.name,
        toolCallId: call.id,
        input: call.arguments,
        preview: descriptor.members[index]!.preview,
        ...(result
          ? {
              result: {
                content: result.content.filter(
                  (block): block is { type: "text"; text: string } => block.type === "text",
                ),
                isError: result.isError,
              },
            }
          : {}),
      };
    });
    return this.tools.restore(descriptor, invocations);
  }
}

function groupConversationTurns(messages: readonly IndexedMessage[]): IndexedMessage[][] {
  const turns: IndexedMessage[][] = [];
  let current: IndexedMessage[] = [];
  for (const entry of messages) {
    if (entry.message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function userMessageText(content: Extract<TranscriptMessage, { role: "user" }>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .filter(Boolean)
    .join("\n");
}
