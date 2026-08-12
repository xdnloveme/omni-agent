import type { PersistentApprovalRequirement } from "@omni-agent/core";
import { aggregateClassifications } from "./aggregate-analysis";
import type { ShellCommandFact, ShellPathFact, ShellUncertaintyFact } from "./analysis-result";
import type { ShellAnalysisContext } from "./shell-analysis-context";
import type { ShellClassification, ShellEffect } from "../classifiers/types";

export interface AnalyzedShellProgram {
  classifications: ShellClassification[];
  commands: ShellCommandFact[];
  paths: ShellPathFact[];
  requirements: PersistentApprovalRequirement[];
  uncertainties: ShellUncertaintyFact[];
  context: ShellAnalysisContext;
}

export function mergeAnalysis(
  left: AnalyzedShellProgram,
  right: AnalyzedShellProgram,
  context: ShellAnalysisContext,
): AnalyzedShellProgram {
  return {
    classifications: [...left.classifications, ...right.classifications],
    commands: [...left.commands, ...right.commands],
    paths: [...left.paths, ...right.paths],
    requirements: [...left.requirements, ...right.requirements],
    uncertainties: [...left.uncertainties, ...right.uncertainties],
    context,
  };
}

export function emptyAnalysis(context: ShellAnalysisContext): AnalyzedShellProgram {
  return {
    classifications: [],
    commands: [],
    paths: [],
    requirements: [],
    uncertainties: [],
    context,
  };
}

export function producedEffects(analysis: AnalyzedShellProgram): readonly ShellEffect[] {
  const effects = [...aggregateClassifications(analysis.classifications).effects];
  if (
    analysis.paths.some(
      ({ access, sensitivity }) => sensitivity === "credential" && access !== "write",
    )
  ) {
    effects.push("credential_read");
  }
  return [...new Set(effects)];
}
