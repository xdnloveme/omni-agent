import {
  assignmentFromWord,
  commandViewFromWords,
  wordAfterPrefix,
  type ShellAssignment,
  type ShellCommandView,
  type ShellWord,
} from "../parser";

const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir"]);
const EXEC_OPTIONS_WITH_VALUE = new Set(["-a"]);
const TIME_OPTIONS_WITH_VALUE = new Set(["-f", "--format", "-o", "--output"]);
const XARGS_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "-E",
  "--eof",
  "-I",
  "--replace",
  "-L",
  "--max-lines",
  "-n",
  "--max-args",
  "-P",
  "--max-procs",
  "-s",
  "--max-chars",
]);
const NO_OPTIONS_WITH_VALUE = new Set<string>();

export type WrapperAnalysis =
  | {
      kind: "argv";
      target: ShellCommandView;
      wrapperOperands: readonly ShellWord[];
      targetContext?: WrapperTargetContext;
    }
  | { kind: "shell"; payload: string; wrapperOperands: readonly ShellWord[] }
  | { kind: "none"; wrapperOperands: readonly ShellWord[] };

export interface WrapperTargetContext {
  cwd?: ShellWord;
  assignments: readonly ShellAssignment[];
}

export function analyzeWrapper(command: ShellCommandView): WrapperAnalysis | null | undefined {
  const { executableName: primary, arguments: args } = command;
  if (primary === "env") {
    if (args.some(({ staticValue }) => staticValue === "-S" || staticValue === "--split-string"))
      return null;
    return analyzeEnvWrapper(args);
  }
  if (primary === "command") {
    if (args.some(({ staticValue }) => staticValue === "-v" || staticValue === "-V")) {
      return { kind: "none", wrapperOperands: args };
    }
    return argvTarget(args);
  }
  if (primary === "builtin") return argvTarget(args);
  if (primary === "exec") return argvTarget(args, EXEC_OPTIONS_WITH_VALUE);
  if (primary === "nohup") return argvTarget(args);
  if (primary === "time") return argvTarget(args, TIME_OPTIONS_WITH_VALUE);
  if (primary === "xargs") return argvTarget(args, XARGS_OPTIONS_WITH_VALUE);
  if (["bash", "sh", "zsh", "dash"].includes(primary)) {
    const commandFlag = args.findIndex(({ staticValue }) => staticValue === "-c");
    if (commandFlag < 0) return undefined;
    const payload = args[commandFlag + 1]?.staticValue;
    return payload === undefined
      ? null
      : { kind: "shell", payload, wrapperOperands: args.slice(0, commandFlag) };
  }
  return undefined;
}

function analyzeEnvWrapper(args: readonly ShellWord[]): WrapperAnalysis | null {
  const index = findWrappedCommandIndex(args, ENV_OPTIONS_WITH_VALUE, true);
  if (index === null) return { kind: "none", wrapperOperands: args };
  const target = commandViewFromWords(args.slice(index));
  if (!target) return null;
  const wrapperOperands = args.slice(0, index);
  return {
    kind: "argv",
    target,
    wrapperOperands,
    targetContext: envTargetContext(wrapperOperands),
  };
}

function envTargetContext(args: readonly ShellWord[]): WrapperTargetContext {
  const assignments: ShellAssignment[] = [];
  let cwd: ShellWord | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word.staticValue === "-C" || word.staticValue === "--chdir") {
      cwd = args[index + 1];
      index += 1;
      continue;
    }
    const inlineCwd = wordAfterPrefix(word, "--chdir=");
    if (inlineCwd) {
      cwd = inlineCwd;
      continue;
    }
    const assignment = assignmentFromWord(word);
    if (assignment) assignments.push(assignment);
  }
  return { ...(cwd ? { cwd } : {}), assignments };
}

function argvTarget(
  args: readonly ShellWord[],
  optionsWithValue: ReadonlySet<string> = NO_OPTIONS_WITH_VALUE,
  skipAssignments = false,
): WrapperAnalysis | null {
  const index = findWrappedCommandIndex(args, optionsWithValue, skipAssignments);
  if (index === null) return { kind: "none", wrapperOperands: args };
  const target = commandViewFromWords(args.slice(index));
  return target ? { kind: "argv", target, wrapperOperands: args.slice(0, index) } : null;
}

function findWrappedCommandIndex(
  args: readonly ShellWord[],
  optionsWithValue: ReadonlySet<string>,
  skipAssignments: boolean,
): number | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!.staticValue;
    if (argument === undefined) return null;
    if (argument === "--") return args[index + 1] ? index + 1 : null;
    if (optionsWithValue.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    if (skipAssignments && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(argument)) continue;
    return index;
  }
  return null;
}
