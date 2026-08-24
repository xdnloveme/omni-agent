import path from "node:path";
import { inspectPathSecurity } from "../../../security/path/inspect-path-security";
import type { ShellAnalysisInput } from "../analysis/analysis-input";
import { resolveShellWord, type ShellAnalysisContext } from "../analysis/shell-analysis-context";
import type { ShellPathFact } from "../analysis/analysis-result";
import type { ShellCommandSemantics } from "../semantics/command-semantics";
import type { ShellCommandView, ShellWord } from "../parser";
import {
  pathOperandPolicy,
  pathValueForOption,
  type OptionOperandKind,
  type PathOptionSpec,
} from "../semantics/operand-policies";

const SAFE_REDIRECTION_TARGET = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;

export interface PathAnalysis {
  facts: readonly ShellPathFact[];
  unresolved: boolean;
}

interface PathCandidate {
  value: string;
  source: ShellPathFact["source"];
  access: ShellPathFact["access"];
}

interface CandidateContext {
  command: ShellCommandView;
  semantics: ShellCommandSemantics;
  input: ShellAnalysisInput;
  shell: ShellAnalysisContext;
  candidates: PathCandidate[];
}

export async function analyzeCommandPaths(
  command: ShellCommandView,
  semantics: ShellCommandSemantics,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  options: {
    operands?: readonly ShellWord[];
    includeRedirections?: boolean;
  } = {},
): Promise<PathAnalysis> {
  const policy = pathOperandPolicy(command.executableName);
  const candidates: PathCandidate[] = [];
  const candidateContext: CandidateContext = {
    command,
    semantics,
    input,
    shell: context,
    candidates,
  };
  let unresolved = context.cwd === "unknown";

  let skippedPatterns = 0;
  let pathOperands = 0;
  let positionalsDisabled = false;
  let optionsEnded = false;
  const operands = options.operands ?? command.arguments;
  for (let index = 0; index < operands.length; index += 1) {
    const word = operands[index]!;
    const argument = resolveShellWord(word, context);
    if (argument === undefined) {
      if (policy.positional === "search" && skippedPatterns < policy.patternOperands) {
        skippedPatterns += 1;
        continue;
      }
      if (policy.positional !== "none") unresolved = true;
      continue;
    }
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    const exactOption = optionsEnded ? undefined : policy.options.get(argument);
    if (exactOption) {
      const processed = processOptionOperands(
        exactOption,
        argument,
        operands,
        index + 1,
        candidateContext,
      );
      index += exactOption.operands.length;
      unresolved ||= processed.unresolved;
      skippedPatterns = processed.sawPattern ? policy.patternOperands : skippedPatterns;
      positionalsDisabled ||= exactOption.disablePositionals === true;
      continue;
    }
    if (!optionsEnded && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argument) && !argument.includes("=@")) {
      continue;
    }
    const option = optionsEnded ? null : splitOptionValue(argument);
    const inlineSpec = option ? policy.options.get(option.name) : undefined;
    if (option && inlineSpec?.operands.length === 1) {
      const processed = processOptionValue(
        inlineSpec.operands[0]!,
        option.name,
        option.value,
        candidateContext,
      );
      unresolved ||= processed.unresolved;
      skippedPatterns = processed.sawPattern ? policy.patternOperands : skippedPatterns;
      positionalsDisabled ||= inlineSpec.disablePositionals === true;
      continue;
    }
    const attached = optionsEnded ? null : attachedShortOption(argument, policy.options);
    if (attached) {
      const processed = processOptionValue(
        attached.spec.operands[0]!,
        attached.name,
        attached.value,
        candidateContext,
      );
      unresolved ||= processed.unresolved;
      skippedPatterns = processed.sawPattern ? policy.patternOperands : skippedPatterns;
      positionalsDisabled ||= attached.spec.disablePositionals === true;
      continue;
    }
    const uploadValue = argument.match(/^[^=]+=@(.+)$/)?.[1];
    if (uploadValue) {
      addCandidate(candidateContext, uploadValue, "option_value", true);
      continue;
    }
    if (policy.positional === "none" || positionalsDisabled) continue;
    if (!optionsEnded && argument.startsWith("-")) {
      const genericOptionValue = argument.match(/^--?[^=]+=(.+)$/)?.[1];
      if (genericOptionValue) {
        addCandidate(candidateContext, genericOptionValue, "option_value");
      }
      continue;
    }
    if (
      policy.positional === "search" &&
      (optionsEnded || !argument.startsWith("-")) &&
      skippedPatterns < policy.patternOperands
    ) {
      skippedPatterns += 1;
      continue;
    }
    if (policy.maxPathOperands !== undefined && pathOperands >= policy.maxPathOperands) continue;
    addCandidate(
      candidateContext,
      argument,
      "argument",
      policy.positional === "paths" || policy.positional === "search",
    );
    pathOperands += 1;
  }

  for (const redirection of options.includeRedirections === false ? [] : command.redirections) {
    if (!redirection.target) continue;
    const target = resolveShellWord(redirection.target, context);
    if (target === undefined) {
      unresolved = true;
      continue;
    }
    if (SAFE_REDIRECTION_TARGET.test(target)) continue;
    const candidate = pathCandidate(target, input, context, true);
    if (candidate) {
      candidates.push({
        value: candidate,
        source: "redirection",
        access: redirection.operator.includes(">") ? "write" : "read",
      });
    }
  }

  if (context.cwd === "unknown") return { facts: [], unresolved: true };
  const facts: ShellPathFact[] = [];
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate.value)
      ? candidate.value
      : path.resolve(context.cwd, candidate.value);
    const inspection = await inspectPathSecurity(absolute, input.cwd, input.environment);
    facts.push({
      path: inspection.target,
      access: candidate.access,
      location: inspection.inWorkspace ? "workspace" : "external",
      sensitivity: inspection.sensitivity,
      source: candidate.source,
    });
  }
  return { facts, unresolved };
}

function processOptionOperands(
  spec: PathOptionSpec,
  optionName: string,
  operands: readonly ShellWord[],
  start: number,
  context: CandidateContext,
): { unresolved: boolean; sawPattern: boolean } {
  let unresolved = false;
  let sawPattern = false;
  for (let offset = 0; offset < spec.operands.length; offset += 1) {
    const valueWord = operands[start + offset];
    const value = valueWord ? resolveShellWord(valueWord, context.shell) : undefined;
    const processed = processOptionValue(spec.operands[offset]!, optionName, value, context);
    unresolved ||= processed.unresolved;
    sawPattern ||= processed.sawPattern;
  }
  return { unresolved, sawPattern };
}

function processOptionValue(
  kind: OptionOperandKind,
  optionName: string,
  value: string | undefined,
  context: CandidateContext,
): { unresolved: boolean; sawPattern: boolean } {
  if (kind === "ignore" || kind === "pattern") {
    return { unresolved: false, sawPattern: kind === "pattern" };
  }
  if (value === undefined) return { unresolved: true, sawPattern: false };
  const candidateValue =
    kind === "at_file"
      ? atFileValue(value)
      : pathValueForOption(context.command.executableName, optionName, value);
  if (candidateValue) {
    addCandidate(context, candidateValue, "option_value", kind !== "heuristic_path");
  }
  return { unresolved: false, sawPattern: kind === "pattern_file" };
}

function addCandidate(
  context: CandidateContext,
  value: string,
  source: ShellPathFact["source"],
  allowPlain = false,
): void {
  const candidate = pathCandidate(
    value.replace(/^@/, ""),
    context.input,
    context.shell,
    false,
    allowPlain,
  );
  if (!candidate) return;
  context.candidates.push({
    value: candidate,
    source,
    access: context.semantics.pathAccess,
  });
}

function splitOptionValue(argument: string): { name: string; value: string } | null {
  const separator = argument.indexOf("=");
  if (separator <= 0) return null;
  return { name: argument.slice(0, separator), value: argument.slice(separator + 1) };
}

function attachedShortOption(
  argument: string,
  options: ReadonlyMap<string, PathOptionSpec>,
): { name: string; value: string; spec: PathOptionSpec } | null {
  for (const [name, spec] of options) {
    if (
      /^-[^-]$/.test(name) &&
      spec.operands.length === 1 &&
      argument.startsWith(name) &&
      argument.length > name.length
    ) {
      return { name, value: argument.slice(name.length), spec };
    }
  }
  return null;
}

function atFileValue(value: string): string | null {
  return value.match(/^@(.+)$/)?.[1] ?? value.match(/^[^@=]+@(.+)$/)?.[1] ?? null;
}

function pathCandidate(
  value: string,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  redirection: boolean,
  allowPlain = false,
): string | null {
  const clean = value.replace(/[;,]$/, "");
  if (
    !clean ||
    clean === "{}" ||
    clean.startsWith("-") ||
    /^[+]\d+$/.test(clean) ||
    /^[a-z]+:\/\//i.test(clean)
  ) {
    return null;
  }
  if (clean === "~" || clean.startsWith("~/")) {
    return path.join(input.environment.home, clean === "~" ? "" : clean.slice(2));
  }
  if (
    redirection ||
    allowPlain ||
    path.isAbsolute(clean) ||
    clean.startsWith("./") ||
    clean.startsWith("../") ||
    (clean.includes("/") && !/[?#]/.test(clean)) ||
    /^\.(?:env(?:\..*)?|envrc|npmrc|pypirc|netrc|pgpass|my\.cnf|git-credentials)$/i.test(clean)
  ) {
    return context.cwd === "unknown" ? null : clean;
  }
  return null;
}
