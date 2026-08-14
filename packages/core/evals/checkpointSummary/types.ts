import type { ContextEntry } from "../../src/context/contracts/types";

export type RecallDimension = "goals" | "constraints" | "unfinishedWork" | "decisions";

export interface ExpectedSignal {
  readonly id: string;
  readonly anyOf: readonly string[];
}

export interface CheckpointEvaluationCase {
  readonly id: string;
  readonly language: "zh" | "en" | "mixed";
  readonly previousCheckpoint?: string;
  readonly sourceEntries: readonly ContextEntry[];
  readonly maxOutputTokens: number;
  readonly expectations: {
    readonly goals: readonly ExpectedSignal[];
    readonly constraints: readonly ExpectedSignal[];
    readonly unfinishedWork: readonly ExpectedSignal[];
    readonly decisions: readonly ExpectedSignal[];
    readonly exactLiterals: readonly string[];
    readonly forbiddenClaims: readonly ExpectedSignal[];
    readonly injectionCanaries: readonly string[];
    readonly currentState: ExpectedSignal;
    readonly nextAction: ExpectedSignal;
    readonly workComplete: boolean;
  };
}

export interface CheckpointEvaluationResponse {
  readonly id: string;
  readonly evaluationContractDigest: string;
  readonly corpusDigest: string;
  readonly response: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly manualReview?: {
    readonly fabricatedFacts: readonly string[];
    readonly injectionFollowed: boolean;
    readonly semanticFailures: readonly string[];
    readonly notes?: string;
  };
}

export interface SignalResult {
  readonly id: string;
  readonly matched: boolean;
  readonly matchedBy?: string;
}

export interface CheckpointCaseEvaluation {
  readonly id: string;
  readonly protocolValid: boolean;
  readonly protocolError?: string;
  readonly recall: Readonly<Record<RecallDimension, readonly SignalResult[]>>;
  readonly exactLiterals: readonly SignalResult[];
  readonly forbiddenClaims: readonly SignalResult[];
  readonly injectionCanaries: readonly SignalResult[];
  readonly currentState: SignalResult;
  readonly nextAction: SignalResult;
  readonly workCompleteCorrect: boolean;
  readonly manualReviewPresent: boolean;
  readonly fabricatedFacts: readonly string[];
  readonly semanticFailures: readonly string[];
  readonly injectionFollowed?: boolean;
  readonly passed: boolean;
}

export interface EvaluationMetric {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  readonly required: number;
  readonly comparator: "at_least" | "at_most";
  readonly passed: boolean;
}

export interface CheckpointEvaluationReport {
  readonly schemaVersion: 2;
  readonly promptVersion: number;
  readonly evaluationContractDigest: string;
  readonly corpusVersion: string;
  readonly corpusDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly createdAt: string;
  readonly caseCount: number;
  readonly evaluatedCaseCount: number;
  readonly manualReviewComplete: boolean;
  readonly metrics: {
    readonly activeGoalRetention: EvaluationMetric;
    readonly activeConstraintRetention: EvaluationMetric;
    readonly unfinishedWorkRecall: EvaluationMetric;
    readonly keyDecisionRecall: EvaluationMetric;
    readonly exactIdentifierAccuracy: EvaluationMetric;
    readonly currentStateAgreement: EvaluationMetric;
    readonly forbiddenClaimRate: EvaluationMetric;
    readonly fabricatedFactRate: EvaluationMetric;
    readonly semanticReviewFailureRate: EvaluationMetric;
    readonly falseCompletionRate: EvaluationMetric;
    readonly injectionInstructionExecutionRate: EvaluationMetric;
    readonly immediateNextActionAgreement: EvaluationMetric;
    readonly outputProtocolValidity: EvaluationMetric;
  };
  readonly cases: readonly CheckpointCaseEvaluation[];
  readonly releaseEligible: boolean;
}
