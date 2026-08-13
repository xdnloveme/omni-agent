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
  const dominant = comparePriority(left, right) >= 0 ? left : right;
  const secondary = dominant === left ? right : left;
  return {
    risk: dominant.risk,
    enforcement:
      left.enforcement === "hard_deny" || right.enforcement === "hard_deny"
        ? "hard_deny"
        : "policy",
    operationClass:
      left.operationClass === "sensitive" || right.operationClass === "sensitive"
        ? "sensitive"
        : "routine",
    reasons: [...dominant.reasons, ...secondary.reasons],
    ruleIds: [...dominant.ruleIds, ...secondary.ruleIds],
    effects: [...new Set([...left.effects, ...right.effects])],
  };
}

function comparePriority(left: ShellClassification, right: ShellClassification): number {
  if (left.enforcement !== right.enforcement) return left.enforcement === "hard_deny" ? 1 : -1;
  return RISK_ORDER.indexOf(left.risk) - RISK_ORDER.indexOf(right.risk);
}
