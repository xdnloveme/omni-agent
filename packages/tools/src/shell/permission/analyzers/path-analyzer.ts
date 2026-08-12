import path from "node:path";
import { inspectPathSecurity } from "../../../security/path/inspect-path-security";
import type { ShellAnalysisInput } from "../analysis/analysis-input";
import { resolveShellWord, type ShellAnalysisContext } from "../analysis/shell-analysis-context";
import type { ShellPathFact } from "../analysis/analysis-result";
import type { ShellClassification } from "../classifiers/types";
import type { ShellCommandView, ShellWord } from "../parser";
import { pathOperandPolicy } from "../semantics/operand-policies";

const SAFE_REDIRECTION_TARGET = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;

export interface PathAnalysis {
  facts: readonly ShellPathFact[];
  unresolved: boolean;
}

export async function analyzeCommandPaths(
  command: ShellCommandView,
  classification: ShellClassification,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  options: {
    operands?: readonly ShellWord[];
    includeRedirections?: boolean;
  } = {},
): Promise<PathAnalysis> {
  const policy = pathOperandPolicy(command.executableName);
  const candidates: Array<{
    value: string;
    source: ShellPathFact["source"];
    access: ShellPathFact["access"];
  }> = [];
  let unresolved = context.cwd === "unknown";

  if (policy !== "text_only") {
    let skippedPatterns = 0;
    for (const word of options.operands ?? command.arguments) {
      const argument = resolveShellWord(word, context);
      if (argument === undefined) {
        if (policy !== "generic" && skippedPatterns < policy.patternOperands) {
          skippedPatterns += 1;
          continue;
        }
        unresolved = true;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument) && !argument.includes("=@")) continue;
      if (
        policy !== "generic" &&
        !argument.startsWith("-") &&
        skippedPatterns < policy.patternOperands
      ) {
        skippedPatterns += 1;
        continue;
      }
      const optionValue = argument.match(/^--?[^=]+=@?(.+)$/)?.[1];
      const uploadValue = argument.match(/^[^=]+=@(.+)$/)?.[1];
      const value = uploadValue ?? optionValue ?? argument.replace(/^@/, "");
      const candidate = pathCandidate(value, input, context, false);
      if (candidate) {
        candidates.push({
          value: candidate,
          source: optionValue || uploadValue ? "option_value" : "argument",
          access: accessFor(classification),
        });
      }
    }
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

function pathCandidate(
  value: string,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  redirection: boolean,
): string | null {
  const clean = value.replace(/[;,]$/, "");
  if (!clean || clean.startsWith("-") || /^[a-z]+:\/\//i.test(clean)) return null;
  if (clean === "~" || clean.startsWith("~/")) {
    return path.join(input.environment.home, clean === "~" ? "" : clean.slice(2));
  }
  if (
    redirection ||
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

function accessFor(classification: ShellClassification): ShellPathFact["access"] {
  if (["write", "destructive", "privileged"].includes(classification.risk)) return "write";
  if (["read", "external_read"].includes(classification.risk)) return "read";
  return "unknown";
}
