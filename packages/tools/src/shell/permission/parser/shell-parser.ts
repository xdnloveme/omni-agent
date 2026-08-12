import { tokenizeShell } from "./shell-tokenizer";
import type { ParsedShellCommand, ParsedShellSegment, ShellAssignment, ShellToken } from "./types";

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

export function parseShellCommand(command: string): ParsedShellCommand {
  const tokenized = tokenizeShell(command);
  const segments = assembleSegments(command, tokenized.tokens);
  const redirections = segments.flatMap((segment) => segment.redirections);
  return {
    raw: command,
    segments,
    redirections,
    malformed:
      tokenized.malformed ||
      hasInvalidControlSequence(tokenized.tokens) ||
      segments.length === 0 ||
      segments.some((segment) => segment.executableIndex === null),
    hasDynamicExecution: tokenized.dynamic,
    hasControlOperator: segments.some((segment) => segment.nextOperator !== undefined),
    hasOutputRedirection: redirections.some(isFileOutputRedirection),
  };
}

function hasInvalidControlSequence(tokens: readonly ShellToken[]): boolean {
  if (tokens[0]?.kind === "control" || tokens[tokens.length - 1]?.kind === "control") return true;
  return tokens.some(
    (token, index) => token.kind === "control" && tokens[index + 1]?.kind === "control",
  );
}

function assembleSegments(command: string, tokens: readonly ShellToken[]): ParsedShellSegment[] {
  const segments: ParsedShellSegment[] = [];
  let current: Exclude<ShellToken, { kind: "control" }>[] = [];
  const push = (nextOperator?: ParsedShellSegment["nextOperator"]) => {
    if (current.length === 0) return;
    const start = current[0]!.start;
    const end = current[current.length - 1]!.end;
    segments.push(createSegment(command.slice(start, end), current, nextOperator));
    current = [];
  };
  for (const token of tokens) {
    if (token.kind === "control") push(token.operator);
    else current.push(token);
  }
  push();
  return segments;
}

function createSegment(
  raw: string,
  tokens: readonly Exclude<ShellToken, { kind: "control" }>[],
  nextOperator: ParsedShellSegment["nextOperator"],
): ParsedShellSegment {
  const words = tokens.filter((token) => token.kind === "word").map((token) => token.word);
  const redirections = tokens
    .filter((token) => token.kind === "redirection")
    .map((token) => token.redirection);
  const leadingAssignments: ShellAssignment[] = [];
  let executableIndex: number | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const match = words[index]!.value.match(ASSIGNMENT);
    if (match && executableIndex === null) {
      leadingAssignments.push({ name: match[1]!, value: match[2]! });
      continue;
    }
    executableIndex = index;
    break;
  }
  return { raw, words, executableIndex, leadingAssignments, redirections, nextOperator };
}

function isFileOutputRedirection(redirection: ParsedShellCommand["redirections"][number]): boolean {
  if (!redirection.operator.includes(">")) return false;
  return !redirection.operator.includes("&") || !/^(?:\d+|-)$/.test(redirection.target);
}
