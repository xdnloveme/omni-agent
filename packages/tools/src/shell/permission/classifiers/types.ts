import type { PermissionRisk } from "@omni-agent/core";
import type { ShellCommandView } from "../parser";

export type ShellEffect = "network_transfer";

export interface ShellClassification {
  risk: PermissionRisk;
  operationClass: "routine" | "sensitive";
  enforcement: "policy" | "hard_deny";
  reasons: string[];
  ruleIds: string[];
  effects: ShellEffect[];
}

export interface ShellClassifier {
  readonly priority: number;
  classify(command: ShellCommandView): ShellClassification | null;
}

export function classification(
  risk: PermissionRisk,
  reason: string,
  ruleId: string,
  options: {
    enforcement?: "policy" | "hard_deny";
    effects?: ShellEffect[];
    operationClass?: "routine" | "sensitive";
  } = {},
): ShellClassification {
  const enforcement = options.enforcement ?? "policy";
  return {
    risk,
    enforcement,
    operationClass: options.operationClass ?? defaultOperationClass(risk, enforcement),
    reasons: [reason],
    ruleIds: [ruleId],
    effects: options.effects ?? [],
  };
}

function defaultOperationClass(
  risk: PermissionRisk,
  enforcement: "policy" | "hard_deny",
): "routine" | "sensitive" {
  return enforcement === "hard_deny" ||
    ["external", "destructive", "privileged", "unknown"].includes(risk)
    ? "sensitive"
    : "routine";
}
