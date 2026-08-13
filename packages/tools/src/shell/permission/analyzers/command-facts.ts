import type { ShellCommandFact } from "../analysis/analysis-result";
import {
  applyPersistentAssignment,
  changeDirectory,
  effectsForShellWord,
  resolveShellWord,
  unsetVariables,
  type ShellAnalysisContext,
} from "../analysis/shell-analysis-context";
import type { ShellClassification, ShellEffect } from "../classifiers/types";
import { assignmentFromWord, type ShellCommandView, type ShellRedirection } from "../parser";

const READ_OPTIONS_WITH_VALUE = new Set(["-d", "-i", "-n", "-N", "-p", "-t", "-u"]);

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
): ShellAnalysisContext {
  if (command.executableName === "cd") {
    const target = command.arguments[0]
      ? resolveShellWord(command.arguments[0], localContext)
      : undefined;
    return changeDirectory(context, target);
  }
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
      command.arguments.flatMap(({ staticValue }) => (staticValue ? [staticValue] : [])),
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
  classification: ShellClassification,
  wrapperChain: readonly string[],
): ShellCommandFact {
  return {
    executable: command.executableName,
    wrapperChain,
    risk: classification.risk,
    operationClass: classification.operationClass,
    reasons: classification.reasons,
    ruleIds: classification.ruleIds,
  };
}
