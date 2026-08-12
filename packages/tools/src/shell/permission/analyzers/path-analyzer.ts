import path from "node:path";
import { inspectPathSecurity } from "../../../security/path/inspect-path-security";
import type { ShellAnalysisInput } from "../analysis/analysis-input";
import type { ShellPathFact } from "../analysis/analysis-result";
import type { ShellClassification } from "../classifiers/types";
import type { ParsedShellWord, ShellCommandView } from "../parser";

type PathOperandPolicy = "generic" | "text_only" | { kind: "search"; patternOperands: number };
const OPERAND_POLICIES: Readonly<Record<string, PathOperandPolicy>> = {
  echo: "text_only",
  printf: "text_only",
  grep: { kind: "search", patternOperands: 1 },
  rg: { kind: "search", patternOperands: 1 },
};
const SAFE_REDIRECTION_TARGET = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;

export async function analyzeCommandPaths(
  command: ShellCommandView,
  classification: ShellClassification,
  input: ShellAnalysisInput,
  options: {
    operands?: readonly ParsedShellWord[];
    includeRedirections?: boolean;
  } = {},
): Promise<ShellPathFact[]> {
  const primary = command.executableName;
  const policy = OPERAND_POLICIES[primary] ?? "generic";
  const candidates: Array<{
    value: string;
    source: ShellPathFact["source"];
    access: ShellPathFact["access"];
  }> = [];
  if (policy !== "text_only") {
    const args = (options.operands ?? command.arguments).map((word) => word.value);
    let skippedPatterns = 0;
    for (const argument of args) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument) && !argument.includes("=@")) continue;
      if (
        policy !== "generic" &&
        !argument.startsWith("-") &&
        skippedPatterns < policy.patternOperands
      ) {
        skippedPatterns += 1;
        continue;
      }
      const optionValue = argument.match(/^(?:--?[^=]+|[^=]+)=@?(.+)$/)?.[1];
      const uploadValue = argument.match(/^[^=]+=@(.+)$/)?.[1];
      const value = uploadValue ?? optionValue ?? argument.replace(/^@/, "");
      const candidate = pathCandidate(value, input);
      if (candidate) {
        candidates.push({
          value: candidate,
          source: optionValue || uploadValue ? "option_value" : "argument",
          access: accessFor(classification),
        });
      }
    }
  }
  for (const redirection of options.includeRedirections === false
    ? []
    : command.segment.redirections) {
    const expanded = expandKnownPathVariables(redirection.target, input);
    if (SAFE_REDIRECTION_TARGET.test(expanded)) continue;
    const candidate = pathCandidate(expanded, input);
    if (candidate) {
      candidates.push({
        value: candidate,
        source: "redirection",
        access: redirection.operator.includes(">") ? "write" : "read",
      });
    }
  }
  const facts: ShellPathFact[] = [];
  for (const candidate of candidates) {
    const inspection = await inspectPathSecurity(candidate.value, input.cwd, input.environment);
    facts.push({
      path: inspection.target,
      access: candidate.access,
      location: inspection.inWorkspace ? "workspace" : "external",
      sensitivity: inspection.sensitivity,
      source: candidate.source,
    });
  }
  return facts;
}

function pathCandidate(value: string, input: ShellAnalysisInput): string | null {
  const clean = expandKnownPathVariables(value.replace(/[;,]$/, ""), input);
  if (!clean || clean.startsWith("-") || /^[a-z]+:\/\//i.test(clean)) return null;
  if (clean === "~" || clean.startsWith("~/"))
    return path.join(input.environment.home, clean.slice(2));
  if (
    path.isAbsolute(clean) ||
    clean.startsWith("./") ||
    clean.startsWith("../") ||
    clean.includes("/") ||
    /^\.(?:env(?:\..*)?|envrc|npmrc|pypirc|netrc|pgpass|my\.cnf|git-credentials)$/i.test(clean)
  )
    return clean;
  return null;
}

function expandKnownPathVariables(value: string, input: ShellAnalysisInput): string {
  return value
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, input.environment.home)
    .replace(/^\$(?:PWD|\{PWD\})(?=\/|$)/, input.cwd);
}

function accessFor(classification: ShellClassification): ShellPathFact["access"] {
  if (["write", "destructive", "privileged"].includes(classification.risk)) return "write";
  if (["read", "external_read"].includes(classification.risk)) return "read";
  return "unknown";
}
