import type { ShellCommandFact, ShellPathFact, ShellUncertaintyFact } from "./analysis-result";
import type { ShellAnalysisContext } from "./shell-analysis-context";
import type { ShellHardStop } from "./analysis-result";
import type { ShellEffect } from "../semantics/command-semantics";

export interface AnalyzedShellProgram {
  effects: ShellEffect[];
  hardStops: ShellHardStop[];
  commands: ShellCommandFact[];
  paths: ShellPathFact[];
  uncertainties: ShellUncertaintyFact[];
  context: ShellAnalysisContext;
}

export function mergeAnalysis(
  left: AnalyzedShellProgram,
  right: AnalyzedShellProgram,
  context: ShellAnalysisContext,
): AnalyzedShellProgram {
  return {
    effects: [...left.effects, ...right.effects],
    hardStops: [...left.hardStops, ...right.hardStops],
    commands: [...left.commands, ...right.commands],
    paths: [...left.paths, ...right.paths],
    uncertainties: [...left.uncertainties, ...right.uncertainties],
    context,
  };
}

export function emptyAnalysis(context: ShellAnalysisContext): AnalyzedShellProgram {
  return {
    effects: [],
    hardStops: [],
    commands: [],
    paths: [],
    uncertainties: [],
    context,
  };
}

export function producedEffects(analysis: AnalyzedShellProgram): readonly ShellEffect[] {
  const effects = [...analysis.effects];
  if (
    analysis.paths.some(
      ({ access, sensitivity }) => sensitivity === "credential" && access !== "write",
    )
  ) {
    effects.push("credential_read");
  }
  return [...new Set(effects)];
}
