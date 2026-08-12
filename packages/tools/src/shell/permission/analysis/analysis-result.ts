import type { PermissionRisk, PersistentApprovalRequirement } from "@omni-agent/core";
import type { PathSensitivity } from "../../../security/path/sensitive-paths";
import type { ShellEffect } from "../classifiers/types";

export interface ShellAnalysisResult {
  syntax: ShellSyntaxSummary;
  commands: readonly ShellCommandFact[];
  paths: readonly ShellPathFact[];
  effects: readonly ShellEffect[];
  security: ShellSecurityAssessment;
  approvalRequirements: readonly PersistentApprovalRequirement[];
}

export interface ShellSyntaxSummary {
  valid: boolean;
  compound: boolean;
  dynamic: boolean;
  segmentCount: number;
}

export interface ShellCommandFact {
  executable: string;
  wrapperChain: readonly string[];
  risk: PermissionRisk;
  operationClass: "routine" | "sensitive";
  reasons: readonly string[];
  ruleIds: readonly string[];
}

export interface ShellPathFact {
  path: string;
  access: "read" | "write" | "unknown";
  location: "workspace" | "external";
  sensitivity: PathSensitivity;
  source: "argument" | "option_value" | "redirection";
}

export interface ShellSecurityAssessment {
  risk: PermissionRisk;
  enforcement: "policy" | "hard_deny";
  operationClass: "routine" | "sensitive";
  reasons: readonly string[];
  ruleIds: readonly string[];
}
