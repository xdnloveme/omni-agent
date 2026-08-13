import path from "node:path";
import type { ShellAnalysisInput } from "./analysis-input";
import type { ShellAssignment, ShellWord } from "../parser";
import type { ShellEffect } from "../classifiers/types";

export const MAX_TRACKED_VARIABLES = 128;

export interface ShellAnalysisContext {
  cwd: string | "unknown";
  literalVariables: ReadonlyMap<string, string>;
  variableEffects: ReadonlyMap<string, readonly ShellEffect[]>;
  variableLimitExceeded: boolean;
}

export function createShellAnalysisContext(input: ShellAnalysisInput): ShellAnalysisContext {
  return {
    cwd: input.cwd,
    literalVariables: new Map([
      ["HOME", input.environment.home],
      ["PWD", input.cwd],
    ]),
    variableEffects: new Map(),
    variableLimitExceeded: false,
  };
}

export function resolveShellWord(
  word: ShellWord,
  context: ShellAnalysisContext,
): string | undefined {
  const values: string[] = [];
  for (const part of word.parts) {
    if (part.kind === "literal") values.push(part.value);
    else if (part.kind === "parameter") {
      const value = context.literalVariables.get(part.name);
      if (value === undefined) return undefined;
      values.push(value);
    } else return undefined;
  }
  return values.join("");
}

export function effectsForShellWord(
  word: ShellWord,
  context: ShellAnalysisContext,
): readonly ShellEffect[] {
  const effects: ShellEffect[] = [];
  for (const part of word.parts) {
    if (part.kind === "parameter") effects.push(...(context.variableEffects.get(part.name) ?? []));
  }
  return [...new Set(effects)];
}

export function applyPersistentAssignment(
  context: ShellAnalysisContext,
  assignment: ShellAssignment,
  effects: readonly ShellEffect[] = [],
): ShellAnalysisContext {
  const variables = new Map(context.literalVariables);
  const variableEffects = new Map(context.variableEffects);
  const value = resolveShellWord(assignment.value, context);
  if (value === undefined) variables.delete(assignment.name);
  else variables.set(assignment.name, value);
  if (effects.length === 0) variableEffects.delete(assignment.name);
  else variableEffects.set(assignment.name, [...new Set(effects)]);
  const variableLimitExceeded = trimVariableState(variables, variableEffects);
  return {
    ...context,
    literalVariables: variables,
    variableEffects,
    variableLimitExceeded: context.variableLimitExceeded || variableLimitExceeded,
  };
}

export function changeDirectory(
  context: ShellAnalysisContext,
  target: string | undefined,
): ShellAnalysisContext {
  if (!target || context.cwd === "unknown") return { ...context, cwd: "unknown" };
  const cwd = path.resolve(context.cwd, target);
  const variables = new Map(context.literalVariables);
  variables.set("PWD", cwd);
  return { ...context, cwd, literalVariables: variables };
}

export function mergeBranchContexts(
  left: ShellAnalysisContext,
  right: ShellAnalysisContext,
): ShellAnalysisContext {
  const variables = new Map<string, string>();
  for (const [name, value] of left.literalVariables) {
    if (right.literalVariables.get(name) === value) variables.set(name, value);
  }
  const cwd = left.cwd === right.cwd ? left.cwd : "unknown";
  if (cwd === "unknown") variables.delete("PWD");
  const variableEffects = new Map<string, readonly ShellEffect[]>();
  for (const name of new Set([...left.variableEffects.keys(), ...right.variableEffects.keys()])) {
    const effects = [
      ...(left.variableEffects.get(name) ?? []),
      ...(right.variableEffects.get(name) ?? []),
    ];
    if (effects.length > 0) variableEffects.set(name, [...new Set(effects)]);
  }
  return {
    cwd,
    literalVariables: variables,
    variableEffects,
    variableLimitExceeded: left.variableLimitExceeded || right.variableLimitExceeded,
  };
}

export function unsetVariables(
  context: ShellAnalysisContext,
  names: readonly string[],
): ShellAnalysisContext {
  const literalVariables = new Map(context.literalVariables);
  const variableEffects = new Map(context.variableEffects);
  for (const name of names) {
    literalVariables.delete(name);
    variableEffects.delete(name);
  }
  return { ...context, literalVariables, variableEffects };
}

export function bindUnknownVariable(
  context: ShellAnalysisContext,
  name: string,
  effects: readonly ShellEffect[] = [],
): ShellAnalysisContext {
  const literalVariables = new Map(context.literalVariables);
  const variableEffects = new Map(context.variableEffects);
  literalVariables.delete(name);
  if (effects.length === 0) variableEffects.delete(name);
  else variableEffects.set(name, [...new Set(effects)]);
  const variableLimitExceeded = trimVariableState(literalVariables, variableEffects);
  return {
    ...context,
    literalVariables,
    variableEffects,
    variableLimitExceeded: context.variableLimitExceeded || variableLimitExceeded,
  };
}

function trimVariableState(
  variables: Map<string, string>,
  effects: Map<string, readonly ShellEffect[]>,
): boolean {
  let exceeded = false;
  const names = () => new Set([...variables.keys(), ...effects.keys()]);
  while (names().size > MAX_TRACKED_VARIABLES) {
    const removable = [...names()].find((key) => key !== "HOME" && key !== "PWD");
    if (!removable) return true;
    variables.delete(removable);
    effects.delete(removable);
    exceeded = true;
  }
  return exceeded;
}
