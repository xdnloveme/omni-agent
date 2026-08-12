import type { ParsedShellWord, ShellCommandView } from "../parser";
import { createNestedCommandView } from "../parser";

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
  | { kind: "argv"; target: ShellCommandView; wrapperOperands: readonly ParsedShellWord[] }
  | { kind: "shell"; command: string; wrapperOperands: readonly ParsedShellWord[] }
  | { kind: "none"; wrapperOperands: readonly ParsedShellWord[] };

export function analyzeWrapper(command: ShellCommandView): WrapperAnalysis | null | undefined {
  const { executableName: primary, arguments: args } = command;
  if (primary === "env") {
    if (args.some(({ value }) => value === "-S" || value === "--split-string")) return null;
    return argvTarget(args, ENV_OPTIONS_WITH_VALUE, true);
  }
  if (primary === "command") {
    if (args.some(({ value }) => value === "-v" || value === "-V")) {
      return { kind: "none", wrapperOperands: args };
    }
    return argvTarget(args);
  }
  if (primary === "exec") return argvTarget(args, EXEC_OPTIONS_WITH_VALUE);
  if (primary === "nohup") return argvTarget(args);
  if (primary === "time") return argvTarget(args, TIME_OPTIONS_WITH_VALUE);
  if (primary === "xargs") return argvTarget(args, XARGS_OPTIONS_WITH_VALUE);
  if (["bash", "sh", "zsh", "dash"].includes(primary)) {
    const commandFlag = args.findIndex(({ value }) => value === "-c");
    if (commandFlag < 0) return undefined;
    const payload = args[commandFlag + 1];
    return payload
      ? { kind: "shell", command: payload.value, wrapperOperands: args.slice(0, commandFlag) }
      : null;
  }
  return undefined;
}

function argvTarget(
  args: readonly ParsedShellWord[],
  optionsWithValue: ReadonlySet<string> = NO_OPTIONS_WITH_VALUE,
  skipAssignments = false,
): WrapperAnalysis | null {
  const index = findWrappedCommandIndex(args, optionsWithValue, skipAssignments);
  if (index === null) return { kind: "none", wrapperOperands: args };
  const target = createNestedCommandView(args.slice(index));
  return target ? { kind: "argv", target, wrapperOperands: args.slice(0, index) } : null;
}

function findWrappedCommandIndex(
  args: readonly ParsedShellWord[],
  optionsWithValue: ReadonlySet<string>,
  skipAssignments: boolean,
): number | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!.value;
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
