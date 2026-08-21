import {
  type ToolCallContent,
  type ToolResultTranscriptMessage,
  type TranscriptMessage,
} from "@omni-agent/core";
import { ThinkingPresenter } from "./thinking-presenter";
import { RunPresentationModel } from "./run-presentation-model";
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
    const visible = turns.slice(-effectiveVisibleTurnCount);
    const hiddenTurnCount = Math.max(0, turns.length - effectiveVisibleTurnCount);
    const results = new Map(
      messages
        .filter((message): message is ToolResultTranscriptMessage => message.role === "toolResult")
        .map((message) => [message.toolCallId, message]),
    );
    const entries: SessionHistoryViewModel["entries"][number][] = [];

    for (const turn of visible) {
      const userEntry = turn.find(({ message }) => message.role === "user");
      if (userEntry?.message.role === "user") {
        const text = userMessageText(userEntry.message.content);
        if (text) entries.push({ type: "user", text });
      }
      const run = this.restoreRun(turn, results);
      if (run) entries.push({ type: "run", run });
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

  private restoreRun(
    turn: readonly IndexedMessage[],
    results: ReadonlyMap<string, ToolResultTranscriptMessage>,
  ) {
    const assistantEntries = turn.filter(
      (
        entry,
      ): entry is IndexedMessage & {
        readonly message: Extract<TranscriptMessage, { role: "assistant" }>;
      } => entry.message.role === "assistant",
    );
    if (assistantEntries.length === 0) return undefined;
    const startedAt = assistantEntries[0]!.message.timestamp;
    const completedAt = Math.max(...turn.map(({ message }) => message.timestamp));
    const run = new RunPresentationModel(`history:run:${turn[0]!.index}`, startedAt);

    for (const { index, message } of assistantEntries) {
      const modelCallId = `history:model:${index}`;
      const calls = message.content.filter(
        (block): block is ToolCallContent => block.type === "toolCall",
      );
      let toolBatchPresented = false;
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type === "text") {
          if (block.text) {
            run.appendText({
              type: "text_delta",
              modelCallId,
              textSegmentId: `${modelCallId}:text:${contentIndex}`,
              delta: block.text,
            });
          }
          continue;
        }
        if (block.type === "thinking") {
          if (block.redacted) continue;
          const disclosure = this.thinking.restore(
            `history:thinking:${index}:${contentIndex}`,
            block.thinking,
          );
          if (disclosure) run.upsertDisclosure(disclosure);
          continue;
        }
        if (toolBatchPresented) continue;
        toolBatchPresented = true;
        const disclosure = this.restoreToolBatch(index, calls, results);
        if (disclosure) run.upsertDisclosure(disclosure);
      }
      if (
        message.stopReason === "stop" &&
        message.content.some((block) => block.type === "text" && block.text.length > 0)
      ) {
        run.markFinal(modelCallId);
      }
    }
    run.complete(completedAt);
    return run.project();
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
