import type { ShellCommandFact } from "../analysis/analysis-result";
import {
  applyPersistentAssignment,
  changeDirectory,
  effectsForShellWord,
  resolveShellWord,
  unsetVariables,
  type ShellAnalysisContext,
} from "../analysis/shell-analysis-context";
import type { ShellCommandSemantics, ShellEffect } from "../semantics/command-semantics";
import {
  isShellBuiltinCommand,
  SHELL_INTERPRETERS,
  SHELL_RESERVED_WORDS,
} from "../semantics/shell-builtins";
import { assignmentFromWord, type ShellCommandView, type ShellRedirection } from "../parser";

const READ_OPTIONS_WITH_VALUE = new Set(["-d", "-i", "-n", "-N", "-p", "-t", "-u"]);
const UNSET_OPTIONS = new Set(["-f", "-n", "-v"]);

export function resolveCommandFacts(
  command: ShellCommandView,
  context: ShellAnalysisContext,
): ShellCommandView {
  return {
    ...command,
    argumentValues: command.arguments.map(
      (word) => resolveShellWord(word, context) ?? word.staticValue ?? word.value,
    ),
    redirections: command.redirections.map((redirection) =>
      resolveRedirectionFact(redirection, context),
    ),
  };
}

export function resolveRedirectionFact(
  redirection: ShellRedirection,
  context: ShellAnalysisContext,
): ShellRedirection {
  if (!redirection.target) return redirection;
  const value = resolveShellWord(redirection.target, context);
  return value === undefined
    ? redirection
    : {
        ...redirection,
        target: { ...redirection.target, value, staticValue: value },
      };
}

export function effectsConsumedByCommand(
  command: ShellCommandView,
  context: ShellAnalysisContext,
): readonly ShellEffect[] {
  const words = [
    ...command.arguments,
    ...command.redirections.flatMap(({ target }) => (target ? [target] : [])),
  ];
  return [...new Set(words.flatMap((word) => effectsForShellWord(word, context)))];
}

export function applyCommandState(
  command: ShellCommandView,
  context: ShellAnalysisContext,
  localContext: ShellAnalysisContext,
  nestedEffects: readonly ShellEffect[],
  semantics: ShellCommandSemantics,
): ShellAnalysisContext {
  if (semantics.directoryChange) return changeDirectory(context, semantics.directoryChange.target);
  if (context.shellFunctions.has(command.executable?.staticValue ?? ""))
    return changeDirectory(context, undefined);
  if (!isShellBuiltinCommand(command, context.shellFunctions)) return context;
  if (command.executableName === "export") {
    return command.arguments.reduce((current, word) => {
      const assignment = assignmentFromWord(word);
      if (!assignment) return current;
      return applyPersistentAssignment(current, assignment, [
        ...nestedEffects,
        ...effectsForShellWord(assignment.value, current),
      ]);
    }, context);
  }
  if (command.executableName === "unset") {
    return unsetVariables(
      context,
      command.arguments.flatMap(({ staticValue }) =>
        staticValue && !UNSET_OPTIONS.has(staticValue) ? [staticValue] : [],
      ),
    );
  }
  if (command.executableName === "read") {
    const names: string[] = [];
    for (let index = 0; index < command.argumentValues.length; index += 1) {
      const argument = command.argumentValues[index]!;
      if (READ_OPTIONS_WITH_VALUE.has(argument)) {
        index += 1;
      } else if (!argument.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(argument)) {
        names.push(argument);
      }
    }
    return unsetVariables(context, names.length > 0 ? names : ["REPLY"]);
  }
  return context;
}

export function commandFact(
  command: ShellCommandView,
  semantics: ShellCommandSemantics,
  wrapperChain: readonly string[],
  context: ShellAnalysisContext,
): ShellCommandFact {
  const executableToken = command.executable?.staticValue ?? command.executable?.value ?? "";
  const shellOwned =
    !executableToken.includes("/") &&
    (isShellBuiltinCommand(command, context.shellFunctions) ||
      isGrammarWord(command, executableToken, wrapperChain));
  return {
    executableName: command.executableName,
    executableToken,
    effectiveCwd: context.cwd,
    executionKind: command.executableName
      ? shellOwned
        ? "builtin"
        : !executableToken.includes("/") && context.shellFunctions.has(command.executableName)
          ? "shell_function"
          : "external"
      : "dynamic",
    wrapperChain,
    effects: semantics.effects,
    pathAccess: semantics.pathAccess,
  };
}

function isGrammarWord(
  command: ShellCommandView,
  executableToken: string,
  wrapperChain: readonly string[],
): boolean {
  if (
    command.executable?.raw !== executableToken ||
    !SHELL_RESERVED_WORDS.has(command.executableName)
  ) {
    return false;
  }
  const immediateWrapper = wrapperChain.at(-1);
  return (
    immediateWrapper === undefined ||
    immediateWrapper === "time" ||
    SHELL_INTERPRETERS.has(immediateWrapper)
  );
}
