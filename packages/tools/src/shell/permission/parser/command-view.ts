import path from "node:path";
import type { ParsedShellSegment, ParsedShellWord, ShellCommandView } from "./types";

export function createShellCommandView(segment: ParsedShellSegment): ShellCommandView {
  const executable =
    segment.executableIndex === null ? null : (segment.words[segment.executableIndex] ?? null);
  const arguments_ =
    segment.executableIndex === null ? [] : segment.words.slice(segment.executableIndex + 1);
  return {
    segment,
    executable,
    executableName: executable ? path.basename(executable.value).toLowerCase() : "",
    arguments: arguments_,
    argumentValues: arguments_.map((word) => word.value),
  };
}

export function createNestedCommandView(
  words: readonly ParsedShellWord[],
): ShellCommandView | null {
  const executable = words[0];
  if (!executable) return null;
  return createShellCommandView({
    raw: executable.raw,
    words,
    executableIndex: 0,
    leadingAssignments: [],
    redirections: [],
  });
}
