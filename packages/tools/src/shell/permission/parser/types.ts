export interface ParsedShellCommand {
  raw: string;
  segments: readonly ParsedShellSegment[];
  redirections: readonly ShellRedirection[];
  malformed: boolean;
  hasDynamicExecution: boolean;
  hasControlOperator: boolean;
  hasOutputRedirection: boolean;
}

export interface ParsedShellSegment {
  raw: string;
  words: readonly ParsedShellWord[];
  executableIndex: number | null;
  leadingAssignments: readonly ShellAssignment[];
  redirections: readonly ShellRedirection[];
  nextOperator?: "|" | "&&" | "||" | ";" | "&";
}

export interface ShellCommandView {
  segment: ParsedShellSegment;
  executable: ParsedShellWord | null;
  executableName: string;
  arguments: readonly ParsedShellWord[];
  argumentValues: readonly string[];
}

export type ShellToken =
  | { kind: "word"; word: ParsedShellWord; start: number; end: number }
  | {
      kind: "control";
      operator: NonNullable<ParsedShellSegment["nextOperator"]>;
      start: number;
      end: number;
    }
  | {
      kind: "redirection";
      redirection: ShellRedirection;
      start: number;
      end: number;
    };

export interface ParsedShellWord {
  raw: string;
  value: string;
  quoted: boolean;
  start: number;
  end: number;
}

export interface ShellAssignment {
  name: string;
  value: string;
}

export interface ShellRedirection {
  operator: string;
  target: string;
  sourceFd?: number;
}
