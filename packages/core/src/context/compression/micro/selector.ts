import type { DeepReadonly } from "../../../data";
import type { ContextEntry } from "../../contracts/types";
import { digestContextValue } from "../../digest";
import type {
  MicroProjectionAssessment,
  MicroProjectionCandidate,
  MicroProjectionLossClass,
  MicroProjectionOptions,
} from "./contracts";

export const MINIMUM_MICRO_REDUCTION_RATIO = 0.5;
export const MICRO_LOSS_CLASS_ORDER = ["discardable", "recoverable", "semantic"] as const;

export interface MicroCandidateSelection {
  readonly sufficient: boolean;
  readonly selected: readonly MicroProjectionCandidate[];
  readonly estimatedSavingsTokens: number;
}

export function createMicroProjectionCandidate(input: {
  readonly strategyKey: string;
  readonly sourceId: string;
  readonly original: DeepReadonly<Exclude<ContextEntry, { kind: "checkpoint" }>>;
  readonly projected: DeepReadonly<Exclude<ContextEntry, { kind: "checkpoint" }>>;
  readonly lossClass: MicroProjectionLossClass;
  readonly options: Pick<MicroProjectionOptions, "estimateEntry">;
}): MicroProjectionCandidate | undefined {
  const estimatedOriginalTokens = input.options.estimateEntry(input.original);
  const estimatedProjectedTokens = input.options.estimateEntry(input.projected);
  const estimatedNetSavingsTokens = estimatedOriginalTokens - estimatedProjectedTokens;
  const reductionRatio =
    estimatedOriginalTokens > 0 ? estimatedNetSavingsTokens / estimatedOriginalTokens : 0;
  if (estimatedNetSavingsTokens <= 0 || reductionRatio < MINIMUM_MICRO_REDUCTION_RATIO) {
    return undefined;
  }
  return {
    strategyKey: input.strategyKey,
    sourceId: input.sourceId,
    sourceIndex: input.original.sourceIndex,
    sourceDigest: digestEntrySource(input.original),
    estimatedOriginalTokens,
    estimatedProjectedTokens,
    estimatedNetSavingsTokens,
    reductionRatio,
    lossClass: input.lossClass,
  };
}

export function selectMicroProjectionCandidates(
  assessments: readonly DeepReadonly<MicroProjectionAssessment>[],
  requiredSavingsTokens: number,
): MicroCandidateSelection {
  const claimedSources = new Map<number, string>();
  for (const assessment of assessments) {
    for (const candidate of assessment.candidates) {
      const owner = claimedSources.get(candidate.sourceIndex);
      if (owner !== undefined) {
        throw new Error(
          `Micro Projection source ${candidate.sourceIndex} is claimed by both ${owner} and ${assessment.strategyName}`,
        );
      }
      claimedSources.set(candidate.sourceIndex, assessment.strategyName);
    }
  }
  const candidates = assessments
    .flatMap((assessment, assessmentOrder) =>
      assessment.candidates.map((candidate) => ({ assessmentOrder, candidate })),
    )
    .sort(
      (left, right) =>
        lossOrder(left.candidate.lossClass) - lossOrder(right.candidate.lossClass) ||
        right.candidate.estimatedNetSavingsTokens - left.candidate.estimatedNetSavingsTokens ||
        left.candidate.sourceIndex - right.candidate.sourceIndex ||
        left.assessmentOrder - right.assessmentOrder ||
        left.candidate.sourceId.localeCompare(right.candidate.sourceId),
    );

  // Prefer lower-loss projections first, then maximize savings within the same
  // loss class to affect the fewest source entries.
  const selected: MicroProjectionCandidate[] = [];
  let estimatedSavingsTokens = 0;
  for (const { candidate } of candidates) {
    selected.push({ ...candidate });
    estimatedSavingsTokens += candidate.estimatedNetSavingsTokens;
    if (estimatedSavingsTokens >= requiredSavingsTokens) break;
  }
  const sufficient = requiredSavingsTokens > 0 && estimatedSavingsTokens >= requiredSavingsTokens;
  return {
    sufficient,
    selected: sufficient ? selected : [],
    estimatedSavingsTokens,
  };
}

export function digestEntrySource(entry: DeepReadonly<ContextEntry>): string {
  if (entry.kind === "checkpoint") return digestContextValue(entry);
  return digestContextValue(entry.message);
}

function lossOrder(lossClass: MicroProjectionLossClass): number {
  const order = MICRO_LOSS_CLASS_ORDER.indexOf(lossClass);
  if (order < 0) throw new Error(`Unknown Micro Projection loss class: ${lossClass}`);
  return order;
}
