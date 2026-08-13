import { commandViewFromWords, type ShellCommandView, type ShellWord } from "../parser";

const EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const EXEC_TERMINATORS = new Set([";", "+"]);
const GLOBAL_OPTIONS = new Set(["-H", "-L", "-P", "-D", "-O"]);
const PATH_PREDICATES = new Set(["-files0-from", "-newer", "-samefile"]);

export interface FindCommandSemantics {
  delegatedCommands: readonly ShellCommandView[];
  pathOperands: readonly ShellWord[];
  unresolvedDelegation: boolean;
}

export function analyzeFindCommand(command: ShellCommandView): FindCommandSemantics | null {
  if (command.executableName !== "find") return null;

  const delegatedCommands: ShellCommandView[] = [];
  const pathOperands: ShellWord[] = [];
  let unresolvedDelegation = false;
  let expressionStarted = false;

  for (let index = 0; index < command.arguments.length; index += 1) {
    const word = command.arguments[index]!;
    const value = word.staticValue ?? "";
    if (!EXEC_ACTIONS.has(value)) {
      if (PATH_PREDICATES.has(value) || /^-newer[acmB][acmtB]$/.test(value)) {
        const target = command.arguments[index + 1];
        if (target) pathOperands.push(target);
        index += 1;
        expressionStarted = true;
      } else if (!expressionStarted && GLOBAL_OPTIONS.has(value)) {
        if (value === "-D" || value === "-O") index += 1;
      } else if (!expressionStarted && !value.startsWith("-") && value !== "!" && value !== "(") {
        pathOperands.push(word);
      } else {
        expressionStarted = true;
      }
      continue;
    }

    expressionStarted = true;

    const targetWords: ShellWord[] = [];
    let terminated = false;
    for (index += 1; index < command.arguments.length; index += 1) {
      const targetWord = command.arguments[index]!;
      if (EXEC_TERMINATORS.has(targetWord.staticValue ?? "")) {
        terminated = true;
        break;
      }
      targetWords.push(targetWord);
    }

    const target = commandViewFromWords(targetWords);
    if (target) delegatedCommands.push(target);
    if (!target || !terminated) unresolvedDelegation = true;
  }

  return { delegatedCommands, pathOperands, unresolvedDelegation };
}
