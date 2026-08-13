import { estimateContextTextTokens } from "../tokenEstimate";
import { CHECKPOINT_SUMMARY_HEADINGS } from "./prompt";

const OPEN_TAG = "<summary>";
const CLOSE_TAG = "</summary>";
const FORBIDDEN_CONTROL_TAG =
  /<\/?(?:summary|context_checkpoint|source_entries|previous_checkpoint)\b/i;

export interface ValidatedCheckpointSummary {
  readonly body: string;
  readonly estimatedTokens: number;
}

export function validateCheckpointSummary(
  response: string,
  maxOutputTokens: number,
): ValidatedCheckpointSummary {
  const normalized = response.trim();
  if (!normalized.startsWith(OPEN_TAG) || !normalized.endsWith(CLOSE_TAG)) {
    throw new InvalidCheckpointSummaryError(
      "Checkpoint summary must be exactly one <summary>...</summary> block",
    );
  }
  if (count(normalized, OPEN_TAG) !== 1 || count(normalized, CLOSE_TAG) !== 1) {
    throw new InvalidCheckpointSummaryError("Checkpoint summary contains multiple summary tags");
  }
  const body = normalized.slice(OPEN_TAG.length, -CLOSE_TAG.length).trim();
  if (!body) throw new InvalidCheckpointSummaryError("Checkpoint summary body is empty");
  if (FORBIDDEN_CONTROL_TAG.test(body)) {
    throw new InvalidCheckpointSummaryError("Checkpoint summary contains a reserved control tag");
  }

  const lines = body.split("\n").map((line) => line.trimEnd());
  const unexpectedHeading = lines.find(
    (line) =>
      line.startsWith("## ") && !CHECKPOINT_SUMMARY_HEADINGS.some((heading) => heading === line),
  );
  if (unexpectedHeading) {
    throw new InvalidCheckpointSummaryError(
      `Checkpoint summary contains an unexpected heading: ${unexpectedHeading}`,
    );
  }
  const headingIndexes = CHECKPOINT_SUMMARY_HEADINGS.map((heading) =>
    lines.reduce<number[]>((indexes, line, index) => {
      if (line === heading) indexes.push(index);
      return indexes;
    }, []),
  );
  if (headingIndexes.some((indexes) => indexes.length !== 1)) {
    throw new InvalidCheckpointSummaryError(
      "Checkpoint summary must contain every required heading exactly once",
    );
  }
  const orderedIndexes = headingIndexes.map(([index]) => index!);
  if (
    orderedIndexes.some((index, position) => position > 0 && index <= orderedIndexes[position - 1]!)
  ) {
    throw new InvalidCheckpointSummaryError("Checkpoint summary headings are out of order");
  }
  for (let index = 0; index < orderedIndexes.length; index++) {
    const start = orderedIndexes[index]! + 1;
    const end = orderedIndexes[index + 1] ?? lines.length;
    const section = lines.slice(start, end).join("\n").trim();
    if (!section) {
      throw new InvalidCheckpointSummaryError(
        `Checkpoint summary section is empty: ${CHECKPOINT_SUMMARY_HEADINGS[index]}`,
      );
    }
    const sectionLines = section.split("\n").map((line) => line.trim());
    if (sectionLines.includes("- None.") && section !== "- None.") {
      throw new InvalidCheckpointSummaryError(
        `Checkpoint summary section mixes - None. with content: ${CHECKPOINT_SUMMARY_HEADINGS[index]}`,
      );
    }
  }

  const currentStateStart = orderedIndexes.at(-1)! + 1;
  const currentState = lines.slice(currentStateStart).filter((line) => line.trim());
  const stateLines = currentState.filter((line) => /^- State:\s*\S/.test(line));
  const nextActionLines = currentState.filter((line) =>
    /^- IMMEDIATE NEXT ACTION:\s*\S/.test(line),
  );
  if (stateLines.length !== 1 || isEmptyField(stateLines[0]!)) {
    throw new InvalidCheckpointSummaryError("Checkpoint summary must contain one current state");
  }
  if (nextActionLines.length !== 1 || isEmptyField(nextActionLines[0]!)) {
    throw new InvalidCheckpointSummaryError(
      "Checkpoint summary must contain one immediate next action",
    );
  }

  const estimatedTokens = estimateContextTextTokens(normalized);
  if (estimatedTokens > maxOutputTokens) {
    throw new InvalidCheckpointSummaryError(
      `Checkpoint summary estimate ${estimatedTokens} exceeds output budget ${maxOutputTokens}`,
    );
  }
  return { body, estimatedTokens };
}

export class InvalidCheckpointSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCheckpointSummaryError";
  }
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function isEmptyField(line: string): boolean {
  const value = line.slice(line.indexOf(":") + 1).trim();
  return /^(?:-\s*)?none\.?$/i.test(value) || /^(?:tbd|unknown)\.?$/i.test(value);
}
