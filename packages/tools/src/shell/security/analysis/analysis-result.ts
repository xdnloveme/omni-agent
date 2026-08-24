import type { PathSensitivity } from "../../../security/path/sensitive-paths";
import type { ShellEffect } from "../semantics/command-semantics";

export interface ShellAnalysisResult {
  syntax: ShellSyntaxSummary;
  commands: readonly ShellCommandFact[];
  paths: readonly ShellPathFact[];
  effects: readonly ShellEffect[];
  uncertainties: readonly ShellUncertaintyFact[];
  security: ShellSecurityAssessment;
}

export interface ShellSyntaxSummary {
  status: "complete" | "partial" | "unsupported";
  compound: boolean;
  nestedExecution: boolean;
}

export interface ShellCommandFact {
  executableName: string;
  executableToken: string;
  effectiveCwd: string | "unknown";
  executionKind: "builtin" | "shell_function" | "external" | "dynamic";
  wrapperChain: readonly string[];
  effects: readonly ShellEffect[];
}

export interface ShellPathFact {
  path: string;
  access: "read" | "write" | "unknown";
  location: "workspace" | "external";
  sensitivity: PathSensitivity;
  source: "argument" | "option_value" | "redirection";
}

export interface ShellUncertaintyFact {
  kind: "execution_target" | "path" | "unsupported_syntax" | "analysis_limit";
  reason: string;
}

export interface ShellSecurityAssessment {
  hardStop?: ShellHardStop;
}

export interface ShellHardStop {
  code: string;
  reason: string;
}
