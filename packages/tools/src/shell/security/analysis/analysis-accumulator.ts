import type { ShellCommandFact, ShellPathFact, ShellUncertaintyFact } from "./analysis-result";
import { mergeBranchContexts, type ShellAnalysisContext } from "./shell-analysis-context";
import type { ShellHardStop } from "./analysis-result";
import type { ShellEffect } from "../semantics/command-semantics";

export interface ShellAnalysisFacts {
  effects: ShellEffect[];
  hardStops: ShellHardStop[];
  commands: ShellCommandFact[];
  paths: ShellPathFact[];
  uncertainties: ShellUncertaintyFact[];
}

export interface ShellOutcomes {
  readonly success: ShellAnalysisContext;
  readonly failure: ShellAnalysisContext;
}

export interface AnalyzedShellProgram extends ShellAnalysisFacts {
  readonly outcomes: ShellOutcomes;
}

/** Use one context when success and failure do not distinguish the resulting state. */
export function sameOutcomes(context: ShellAnalysisContext): ShellOutcomes {
  return { success: context, failure: context };
}

/** Unconditional continuation joins outcomes; it is never stored as a third state. */
export function continuedContext(analysis: AnalyzedShellProgram): ShellAnalysisContext {
  const { success, failure } = analysis.outcomes;
  return success === failure ? success : mergeBranchContexts(success, failure);
}

/** Facts may cross a scope boundary; execution state must be selected by its owner. */
export function mergeAnalysisFacts(
  left: ShellAnalysisFacts,
  right: ShellAnalysisFacts,
): ShellAnalysisFacts {
  return {
    effects: [...left.effects, ...right.effects],
    hardStops: [...left.hardStops, ...right.hardStops],
    commands: [...left.commands, ...right.commands],
    paths: [...left.paths, ...right.paths],
    uncertainties: [...left.uncertainties, ...right.uncertainties],
  };
}

export function emptyAnalysis(context: ShellAnalysisContext): AnalyzedShellProgram {
  return {
    effects: [],
    hardStops: [],
    commands: [],
    paths: [],
    uncertainties: [],
    outcomes: sameOutcomes(context),
  };
}

export function producedEffects(analysis: ShellAnalysisFacts): readonly ShellEffect[] {
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
