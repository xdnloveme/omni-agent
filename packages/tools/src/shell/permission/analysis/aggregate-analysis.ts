import type { PermissionRisk } from "@omni-agent/core";
import type { ShellClassification } from "../classifiers/types";

const RISK_ORDER: readonly PermissionRisk[] = [
  "read",
  "write",
  "execute",
  "external_read",
  "external",
  "unknown",
  "destructive",
  "privileged",
];

export function aggregateClassifications(
  classifications: readonly ShellClassification[],
): ShellClassification {
  return classifications.reduce(maximum, emptyClassification());
}

export function unknownClassification(reason: string, ruleId: string): ShellClassification {
  return {
    risk: "unknown",
    operationClass: "sensitive",
    enforcement: "policy",
    reasons: [reason],
    ruleIds: [ruleId],
    effects: [],
  };
}

function emptyClassification(): ShellClassification {
  return {
    risk: "read",
    operationClass: "routine",
    enforcement: "policy",
    reasons: [],
    ruleIds: [],
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
