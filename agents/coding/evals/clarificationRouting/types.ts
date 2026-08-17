export type ClarificationDecision = "ask" | "proceed";

export interface ClarificationEvaluationCase {
  readonly id: string;
  readonly language: "zh" | "en";
  readonly category:
    | "material_choice"
    | "discoverable_fact"
    | "safe_default"
    | "complete_instruction"
    | "permission_boundary"
    | "clarification_result";
  readonly messages: readonly Record<string, unknown>[];
  readonly expected: ClarificationDecision;
}

export interface CapturedToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ClarificationEvaluationResponse {
  readonly id: string;
  readonly evaluationContractDigest: string;
  readonly corpusDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly text?: string;
  readonly toolCalls: readonly CapturedToolCall[];
  readonly manualReview?: {
    readonly decisionFocused: boolean;
    readonly optionsMutuallyExclusive: boolean;
    readonly recommendationAndTradeoffs: boolean;
    readonly customInputHandledCorrectly: boolean;
    readonly notes?: string;
  };
  readonly continuationReview?: {
    readonly continuedAppropriately: boolean;
    readonly notes?: string;
  };
}

export interface EvaluationMetric {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  readonly required: number;
  readonly comparator: "at_least" | "at_most";
  readonly passed: boolean;
}

export interface ClarificationCaseEvaluation {
  readonly id: string;
  readonly expected: ClarificationDecision;
  readonly actual: ClarificationDecision;
  readonly requestCount: number;
  readonly questionCount: number | null;
  readonly requestValid: boolean;
  readonly manualReviewPresent: boolean;
  readonly questionQualityPassed: boolean;
  readonly continuationReviewPresent: boolean;
  readonly continuationPassed: boolean;
  readonly passed: boolean;
}

export interface ClarificationEvaluationReport {
  readonly schemaVersion: 1;
  readonly evaluationContractDigest: string;
  readonly corpusDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly createdAt: string;
  readonly caseCount: number;
  readonly metrics: {
    readonly routingAccuracy: EvaluationMetric;
    readonly askRecall: EvaluationMetric;
    readonly askPrecision: EvaluationMetric;
    readonly unnecessaryInterruptionRate: EvaluationMetric;
    readonly validRequestRate: EvaluationMetric;
    readonly questionQualityRate: EvaluationMetric;
    readonly skipContinuationRate: EvaluationMetric;
    readonly answeredContinuationRate: EvaluationMetric;
  };
  readonly cases: readonly ClarificationCaseEvaluation[];
  readonly manualReviewComplete: boolean;
  readonly releaseEligible: boolean;
}
