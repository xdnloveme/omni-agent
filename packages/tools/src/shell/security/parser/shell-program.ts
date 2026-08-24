import path from "node:path";

export type ShellProgramStatus = "complete" | "partial" | "unsupported";

export interface ShellProgram {
  body: readonly ShellStatement[];
  status: ShellProgramStatus;
}

export type ShellStatement =
  | { kind: "command"; command: ShellCommandView }
  | { kind: "assignment"; assignment: ShellAssignment; nested: readonly ShellProgram[] }
  | { kind: "noop"; nested: readonly ShellProgram[] }
  | { kind: "pipeline"; statements: readonly ShellStatement[] }
  | { kind: "background"; statement: ShellStatement }
  | {
      kind: "list";
      operator: "&&" | "||" | ";";
      left: ShellStatement;
      right: ShellStatement;
    }
  | { kind: "group"; statements: readonly ShellStatement[]; scoped: boolean }
  | {
      kind: "loop";
      condition: readonly ShellStatement[];
      body: readonly ShellStatement[];
      nested: readonly ShellProgram[];
      variable?: string;
    }
  | {
      kind: "branch";
      condition: readonly ShellStatement[];
      branches: readonly (readonly ShellStatement[])[];
      nested: readonly ShellProgram[];
    }
  | { kind: "function"; name: string; statements: readonly ShellStatement[] }
  | {
      kind: "redirected";
      statement: ShellStatement;
      redirections: readonly ShellRedirection[];
      nested: readonly ShellProgram[];
    }
  | { kind: "unsupported"; statements: readonly ShellStatement[]; syntaxType: string };

export interface ShellCommandView {
  raw: string;
  executable: ShellWord | null;
  executableName: string;
  arguments: readonly ShellWord[];
  argumentValues: readonly string[];
  leadingAssignments: readonly ShellAssignment[];
  redirections: readonly ShellRedirection[];
  nested: readonly ShellProgram[];
  span: ShellSourceSpan;
}

export interface ShellWord {
  raw: string;
  value: string;
  staticValue?: string;
  parts: readonly ShellWordPart[];
  span: ShellSourceSpan;
}

export type ShellWordPart =
  | { kind: "literal"; value: string }
  | { kind: "parameter"; name: string }
  | { kind: "command_output"; program: ShellProgram }
  | { kind: "process_substitution"; program: ShellProgram }
  | { kind: "unresolved"; syntaxType: string };

export interface ShellAssignment {
  name: string;
  value: ShellWord;
}

export interface ShellRedirection {
  operator: string;
  target?: ShellWord;
  sourceFd?: number;
}

export interface ShellSourceSpan {
  startByte: number;
  endByte: number;
}

export function nestedProgramsOfWord(word: ShellWord): readonly ShellProgram[] {
  return word.parts.flatMap((part) =>
    part.kind === "command_output" || part.kind === "process_substitution" ? [part.program] : [],
  );
}

export function commandViewFromWords(words: readonly ShellWord[]): ShellCommandView | null {
  const executable = words[0];
  if (!executable) return null;
  const executableName = executable.staticValue
    ? path.basename(executable.staticValue).toLowerCase()
    : "";
  return {
    raw: executable.raw,
    executable,
    executableName,
    arguments: words.slice(1),
    argumentValues: words.slice(1).map((word) => word.staticValue ?? word.value),
    leadingAssignments: [],
    redirections: [],
    nested: words.flatMap(nestedProgramsOfWord),
    span: { startByte: executable.span.startByte, endByte: words.at(-1)!.span.endByte },
  };
}

export function assignmentFromWord(word: ShellWord): ShellAssignment | null {
  const first = word.parts[0];
  if (first?.kind !== "literal") return null;
  const match = first.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!match) return null;
  return { name: match[1]!, value: wordAfterPrefix(word, match[0])! };
}

export function wordAfterPrefix(word: ShellWord, prefix: string): ShellWord | null {
  const first = word.parts[0];
  if (first?.kind !== "literal" || !first.value.startsWith(prefix)) return null;
  const parts: ShellWordPart[] = [
    { kind: "literal", value: first.value.slice(prefix.length) },
    ...word.parts.slice(1),
  ];
  const staticValue = parts.every((part) => part.kind === "literal")
    ? parts.map((part) => (part.kind === "literal" ? part.value : "")).join("")
    : undefined;
  const { staticValue: _staticValue, ...base } = word;
  return {
    ...base,
    raw: word.raw.slice(prefix.length),
    value: staticValue ?? word.value.slice(prefix.length),
    ...(staticValue === undefined ? {} : { staticValue }),
    parts,
  };
}
