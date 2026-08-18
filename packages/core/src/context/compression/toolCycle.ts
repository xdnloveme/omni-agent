import type { ToolResultTranscriptMessage } from "../../messages";
import { digestContextValue } from "../digest";
import type { ContextEntry } from "../contracts/types";
import type { ContextToolCycle, ContextToolCycleView } from "./micro/contracts";

interface IndexedCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly sourceIndex: number;
  readonly contentIndex: number;
  readonly sourceDigest: string;
}

interface IndexedResult {
  readonly message: ToolResultTranscriptMessage;
  readonly sourceIndex: number;
  readonly sourceDigest: string;
}

export function createContextToolCycleView(entries: readonly ContextEntry[]): ContextToolCycleView {
  const calls = new Map<string, IndexedCall[]>();
  const results = new Map<string, IndexedResult[]>();
  const assistantIndexes: number[] = [];

  for (const entry of entries) {
    if (entry.kind === "transcript" && entry.message.role === "assistant") {
      assistantIndexes.push(entry.sourceIndex);
      entry.message.content.forEach((block, contentIndex) => {
        if (block.type !== "toolCall") return;
        append(calls, block.id, {
          toolCallId: block.id,
          toolName: block.name,
          sourceIndex: entry.sourceIndex,
          contentIndex,
          sourceDigest: digestContextValue(entry.message),
        });
      });
      continue;
    }
    if (entry.kind === "checkpoint") continue;
    const message = toolResultMessage(entry);
    if (!message) continue;
    append(results, message.toolCallId, {
      message,
      sourceIndex: entry.sourceIndex,
      sourceDigest: digestContextValue(message),
    });
  }

  const cycles = [...new Set([...calls.keys(), ...results.keys()])]
    .map((toolCallId) =>
      createCycle(
        toolCallId,
        calls.get(toolCallId) ?? [],
        results.get(toolCallId) ?? [],
        assistantIndexes,
      ),
    )
    .sort(compareCycles);
  const byResultSourceIndex = new Map(
    cycles.flatMap((cycle) => (cycle.result ? ([[cycle.result.sourceIndex, cycle]] as const) : [])),
  );

  return Object.freeze({
    cycles: Object.freeze(cycles.map(freezeCycle)),
    findByResultSourceIndex(sourceIndex: number) {
      return byResultSourceIndex.get(sourceIndex);
    },
  });
}

function createCycle(
  toolCallId: string,
  calls: readonly IndexedCall[],
  results: readonly IndexedResult[],
  assistantIndexes: readonly number[],
): ContextToolCycle {
  const call = calls[0];
  const result = results[0];
  const duplicated = calls.length > 1 || results.length > 1;
  const status = duplicated
    ? "duplicate"
    : !call
      ? "orphan_result"
      : !result
        ? "pending"
        : call.toolName !== result.message.toolName
          ? "name_mismatch"
          : "completed";
  const resultIndex = result?.sourceIndex;
  const sourceIndexes = [
    ...calls.map((item) => item.sourceIndex),
    ...results.map((item) => item.sourceIndex),
  ];

  // A result becomes eligible only after a later assistant message proves that
  // the model has already consumed the complete tool cycle.
  const consumed =
    status === "completed" &&
    resultIndex !== undefined &&
    assistantIndexes.some((sourceIndex) => sourceIndex > resultIndex);

  return {
    toolCallId,
    toolName: call?.toolName ?? result?.message.toolName ?? "",
    span: {
      startSourceIndex: Math.min(...sourceIndexes),
      endSourceIndex: Math.max(...sourceIndexes),
    },
    ...(call
      ? {
          call: {
            sourceIndex: call.sourceIndex,
            contentIndex: call.contentIndex,
            sourceDigest: call.sourceDigest,
          },
        }
      : {}),
    ...(result
      ? {
          result: {
            sourceIndex: result.sourceIndex,
            sourceDigest: result.sourceDigest,
            isError: result.message.isError,
          },
        }
      : {}),
    status,
    consumed,
  };
}

function toolResultMessage(entry: ContextEntry): ToolResultTranscriptMessage | undefined {
  if (entry.kind === "toolResultArtifact") return entry.message;
  return entry.kind === "transcript" && entry.message.role === "toolResult"
    ? entry.message
    : undefined;
}

function append<T>(target: Map<string, T[]>, key: string, value: T): void {
  const values = target.get(key);
  if (values) values.push(value);
  else target.set(key, [value]);
}

function compareCycles(left: ContextToolCycle, right: ContextToolCycle): number {
  return (
    firstSourceIndex(left) - firstSourceIndex(right) ||
    left.toolCallId.localeCompare(right.toolCallId)
  );
}

function firstSourceIndex(cycle: ContextToolCycle): number {
  return Math.min(
    cycle.call?.sourceIndex ?? Number.MAX_SAFE_INTEGER,
    cycle.result?.sourceIndex ?? Number.MAX_SAFE_INTEGER,
  );
}

function freezeCycle(cycle: ContextToolCycle): ContextToolCycle {
  Object.freeze(cycle.span);
  if (cycle.call) Object.freeze(cycle.call);
  if (cycle.result) Object.freeze(cycle.result);
  return Object.freeze(cycle);
}
