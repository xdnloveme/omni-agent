import type { PermissionRisk } from "@omni-agent/core";

export type ShellEffect = "network_transfer";

export interface ShellClassification {
  risk: PermissionRisk;
  enforcement: "policy" | "hard_deny";
  reasons: string[];
  ruleIds: string[];
  effects: ShellEffect[];
}

export interface ShellClassifier {
  readonly priority: number;
  classify(words: readonly string[], segment: string): ShellClassification | null;
}

export function classification(
  risk: PermissionRisk,
  reason: string,
  ruleId: string,
  enforcement: "policy" | "hard_deny" = "policy",
  effects: ShellEffect[] = [],
): ShellClassification {
  return { risk, enforcement, reasons: [reason], ruleIds: [ruleId], effects };
}
