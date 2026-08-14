import { readFile } from "node:fs/promises";
import { digestContextValue } from "../../src/context/digest";
import type { ContextEntry } from "../../src/context/contracts/types";
import { cloneData } from "../../src/dataCopy";
import type {
  AssistantTranscriptMessage,
  ToolResultTranscriptMessage,
  UserTranscriptMessage,
} from "../../src/messages";
import type { CheckpointEvaluationCase } from "./types";

export const CHECKPOINT_CORPUS_VERSION = "2";

interface RawCheckpointEvaluationCase extends Omit<CheckpointEvaluationCase, "sourceEntries"> {
  readonly sourceEntries: readonly RawSourceEntry[];
  readonly pressure?: {
    readonly pairs: number;
    readonly userText: string;
    readonly assistantText: string;
    readonly toolResultPadding?: {
      readonly repeats: number;
      readonly text: string;
    };
  };
}

type RawSourceEntry =
  | {
      readonly role: "user";
      readonly content: UserTranscriptMessage["content"];
    }
  | {
      readonly role: "assistant";
      readonly content: AssistantTranscriptMessage["content"];
      readonly stopReason: AssistantTranscriptMessage["stopReason"];
      readonly errorMessage?: string;
    }
  | {
      readonly role: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
      readonly content: ToolResultTranscriptMessage["content"];
    }
  | {
      readonly kind: "artifact";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly artifactId: string;
      readonly artifactPath: string;
      readonly contentDigest: string;
      readonly recoveryInstruction: string;
    };

export async function loadCheckpointCorpus(path: string): Promise<{
  readonly cases: readonly CheckpointEvaluationCase[];
  readonly digest: string;
}> {
  const source = await readFile(path, "utf8");
  const cases = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseCase(line, index + 1));
  validateCorpus(cases);
  return { cases, digest: digestContextValue(cases) };
}

function parseCase(line: string, lineNumber: number): CheckpointEvaluationCase {
  try {
    const raw = JSON.parse(line) as RawCheckpointEvaluationCase;
    const entries = applyPressure(raw.sourceEntries, raw.pressure);
    const { sourceEntries: _sourceEntries, pressure: _pressure, ...item } = raw;
    return { ...item, sourceEntries: entries.map(toContextEntry) };
  } catch (error) {
    throw new Error(
      `Invalid checkpoint corpus JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function applyPressure(
  entries: readonly RawSourceEntry[],
  pressure: RawCheckpointEvaluationCase["pressure"],
): RawSourceEntry[] {
  if (!pressure) return [...entries];
  if (!Number.isInteger(pressure.pairs) || pressure.pairs <= 0) {
    throw new Error("Checkpoint pressure pairs must be a positive integer");
  }
  let expandedEntries = [...entries];
  if (pressure.toolResultPadding) {
    const { repeats, text } = pressure.toolResultPadding;
    if (!Number.isInteger(repeats) || repeats <= 0 || !text) {
      throw new Error("Checkpoint tool-result pressure must have positive repeats and text");
    }
    let padded = false;
    expandedEntries = expandedEntries.map((entry) => {
      if (padded || !("role" in entry) || entry.role !== "toolResult") return entry;
      padded = true;
      const suffix = Array.from({ length: repeats }, (_, index) => `${text} #${index + 1}`).join(
        "\n",
      );
      return {
        ...entry,
        content: entry.content.map((block, index) =>
          index === 0 && block.type === "text"
            ? { ...block, text: `${block.text}\n${suffix}` }
            : block,
        ),
      };
    });
    if (!padded) throw new Error("Checkpoint tool-result pressure requires a Tool Result entry");
  }
  const insertAt = Math.max(expandedEntries.length - 1, 0);
  const distractors: RawSourceEntry[] = [];
  for (let index = 0; index < pressure.pairs; index++) {
    distractors.push(
      { role: "user", content: `${pressure.userText} #${index + 1}` },
      {
        role: "assistant",
        content: [{ type: "text", text: `${pressure.assistantText} #${index + 1}` }],
        stopReason: "stop",
      },
    );
  }
  return [
    ...expandedEntries.slice(0, insertAt),
    ...distractors,
    ...expandedEntries.slice(insertAt),
  ];
}

function toContextEntry(entry: RawSourceEntry, sourceIndex: number): ContextEntry {
  if ("kind" in entry) {
    return {
      kind: "toolResultArtifact",
      sourceIndex,
      message: {
        role: "toolResult",
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        content: [{ type: "text", text: "Artifact content externalized for evaluation." }],
        isError: false,
        timestamp: 0,
      },
      artifact: {
        id: entry.artifactId,
        path: entry.artifactPath,
        contentDigest: entry.contentDigest,
        originalLength: 1,
        recoveryInstruction: entry.recoveryInstruction,
      },
    };
  }
  if (entry.role === "user") {
    return {
      kind: "transcript",
      sourceIndex,
      message: { role: "user", content: cloneData(entry.content), timestamp: 0 },
    };
  }
  if (entry.role === "assistant") {
    return {
      kind: "transcript",
      sourceIndex,
      message: {
        role: "assistant",
        content: cloneData(entry.content),
        api: "evaluation",
        provider: "evaluation",
        model: "evaluation",
        stopReason: entry.stopReason,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        timestamp: 0,
        ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
      },
    };
  }
  return {
    kind: "transcript",
    sourceIndex,
    message: {
      role: "toolResult",
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      content: cloneData(entry.content),
      isError: entry.isError,
      timestamp: 0,
    },
  };
}

function validateCorpus(cases: readonly CheckpointEvaluationCase[]): void {
  if (cases.length === 0) throw new Error("Checkpoint evaluation corpus is empty");
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id?.trim()) throw new Error("Checkpoint evaluation case id is required");
    if (ids.has(item.id)) throw new Error(`Duplicate checkpoint evaluation case id: ${item.id}`);
    ids.add(item.id);
    if (!Number.isInteger(item.maxOutputTokens) || item.maxOutputTokens <= 0) {
      throw new Error(`Invalid maxOutputTokens for checkpoint evaluation case: ${item.id}`);
    }
    if (item.sourceEntries.length === 0) {
      throw new Error(`Checkpoint evaluation source entries are required: ${item.id}`);
    }
    for (const dimension of ["goals", "constraints", "unfinishedWork", "decisions"] as const) {
      if (item.expectations[dimension].length === 0) {
        throw new Error(`Checkpoint evaluation ${dimension} are required: ${item.id}`);
      }
    }
    if (item.expectations.exactLiterals.length === 0) {
      throw new Error(`Checkpoint evaluation exact literals are required: ${item.id}`);
    }
    for (const signal of allSignals(item)) {
      if (!signal.id?.trim() || signal.anyOf.length === 0 || signal.anyOf.some((value) => !value)) {
        throw new Error(`Invalid expected signal in checkpoint evaluation case: ${item.id}`);
      }
    }
  }
}

function allSignals(item: CheckpointEvaluationCase) {
  return [
    ...item.expectations.goals,
    ...item.expectations.constraints,
    ...item.expectations.unfinishedWork,
    ...item.expectations.decisions,
    ...item.expectations.forbiddenClaims,
    item.expectations.currentState,
    item.expectations.nextAction,
  ];
}
