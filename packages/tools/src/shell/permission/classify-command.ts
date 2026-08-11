import type { PermissionRisk } from "@omni-agent/core";
import { parseShellCommand, shellWords } from "./shell-parser";
import { classifyCommand } from "./classifiers/command-classifiers";
import { classifyWholeCommandHardStop } from "./classifiers/hard-stop-classifier";
import type { ShellClassification } from "./classifiers/types";
import { unwrapCommand } from "./classifiers/wrapper-classifier";

const RISK_ORDER: PermissionRisk[] = [
  "read",
  "write",
  "execute",
  "external_read",
  "external",
  "unknown",
  "destructive",
  "privileged",
];

export function classifyBashCommand(command: string, cwd: string): ShellClassification {
  return classify(command, cwd, 0);
}

function classify(command: string, cwd: string, depth: number): ShellClassification {
  if (depth > 8)
    return unknown("Wrapper nesting exceeds the analysis limit", "shell.unknown.wrapper-depth");
  const parsed = parseShellCommand(command);
  const hardStop = classifyWholeCommandHardStop(command, cwd);
  if (hardStop) return hardStop;
  if (parsed.malformed || parsed.hasDynamicExecution)
    return unknown("Command contains dynamic or malformed shell syntax", "shell.unknown.dynamic");
  let result: ShellClassification = {
    risk: "read",
    operationClass: "routine",
    enforcement: "policy",
    reasons: [],
    ruleIds: [],
    effects: [],
  };
  for (const segment of parsed.segments) {
    const unwrapped = unwrapCommand(segment);
    const segmentResult =
      unwrapped === null
        ? unknown("Wrapper target command is unknown", "shell.unknown.wrapper")
        : unwrapped !== segment
          ? classify(unwrapped, cwd, depth + 1)
          : classifyCommand(shellWords(segment), segment);
    result = maximum(result, segmentResult);
  }
  if (parsed.hasOutputRedirection && result.risk === "read")
    result = maximum(result, {
      risk: "write",
      operationClass: "routine",
      enforcement: "policy",
      reasons: ["Shell output redirection writes to a file"],
      ruleIds: ["shell.write.redirection"],
      effects: [],
    });
  return result;
}

function unknown(reason: string, ruleId: string): ShellClassification {
  return {
    risk: "unknown",
    operationClass: "sensitive",
    enforcement: "policy",
    reasons: [reason],
    ruleIds: [ruleId],
    effects: [],
  };
}

function maximum(left: ShellClassification, right: ShellClassification): ShellClassification {
  return {
    risk: RISK_ORDER.indexOf(left.risk) >= RISK_ORDER.indexOf(right.risk) ? left.risk : right.risk,
    enforcement:
      left.enforcement === "hard_deny" || right.enforcement === "hard_deny"
        ? "hard_deny"
        : "policy",
    operationClass:
      left.operationClass === "sensitive" || right.operationClass === "sensitive"
        ? "sensitive"
        : "routine",
    reasons: [...left.reasons, ...right.reasons],
    ruleIds: [...left.ruleIds, ...right.ruleIds],
    effects: [...new Set([...left.effects, ...right.effects])],
  };
}
