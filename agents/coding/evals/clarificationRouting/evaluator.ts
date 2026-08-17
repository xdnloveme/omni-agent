import { createClarificationEvaluationContract } from "./contract";
import type {
  ClarificationCaseEvaluation,
  ClarificationEvaluationCase,
  ClarificationEvaluationReport,
  ClarificationEvaluationResponse,
  EvaluationMetric,
} from "./types";

const TOOL_NAME = "request_user_input";

export function evaluateClarificationCase(
  item: ClarificationEvaluationCase,
  response: ClarificationEvaluationResponse,
): ClarificationCaseEvaluation {
  const requests = response.toolCalls.filter((call) => call.name === TOOL_NAME);
  const actual = requests.length > 0 ? "ask" : "proceed";
  const request = requests[0];
  const questions = Array.isArray(request?.arguments.questions)
    ? request.arguments.questions
    : undefined;
  const questionCount = questions?.length ?? null;
  const requestValid =
    requests.length <= 1 &&
    (requests.length === 0 ||
      (questions !== undefined &&
        questions.length >= 1 &&
        questions.length <= 3 &&
        areValidQuestions(questions)));
  const manualReviewPresent = actual === "proceed" || response.manualReview !== undefined;
  const questionQualityPassed =
    actual === "proceed" ||
    Boolean(
      response.manualReview?.decisionFocused &&
      response.manualReview.optionsMutuallyExclusive &&
      response.manualReview.recommendationAndTradeoffs &&
      response.manualReview.customInputHandledCorrectly,
    );
  const requiresContinuationReview = item.category === "clarification_result";
  const continuationReviewPresent =
    !requiresContinuationReview || response.continuationReview !== undefined;
  const continuationPassed =
    !requiresContinuationReview || response.continuationReview?.continuedAppropriately === true;
  return {
    id: item.id,
    expected: item.expected,
    actual,
    requestCount: requests.length,
    questionCount,
    requestValid,
    manualReviewPresent,
    questionQualityPassed,
    continuationReviewPresent,
    continuationPassed,
    passed:
      actual === item.expected &&
      requestValid &&
      manualReviewPresent &&
      questionQualityPassed &&
      continuationReviewPresent &&
      continuationPassed,
  };
}

export function createClarificationEvaluationReport(input: {
  readonly cases: readonly ClarificationEvaluationCase[];
  readonly responses: readonly ClarificationEvaluationResponse[];
  readonly evaluationContractDigest: string;
  readonly corpusDigest: string;
}): ClarificationEvaluationReport {
  const responses = new Map(input.responses.map((response) => [response.id, response]));
  if (responses.size !== input.responses.length)
    throw new Error("Duplicate evaluation response id");
  const unknown = input.responses.find(
    (response) => !input.cases.some((item) => item.id === response.id),
  );
  if (unknown) throw new Error(`Unknown clarification evaluation response: ${unknown.id}`);
  const identities = new Set(
    input.responses.map((response) =>
      JSON.stringify([response.provider, response.model, response.responseModel]),
    ),
  );
  if (identities.size !== 1) throw new Error("Evaluation responses must use one model identity");

  const evaluations = input.cases.map((item) => {
    const response = responses.get(item.id);
    if (!response) throw new Error(`Missing clarification evaluation response: ${item.id}`);
    if (response.evaluationContractDigest !== input.evaluationContractDigest) {
      throw new Error(`Clarification evaluation contract digest mismatch: ${item.id}`);
    }
    if (response.corpusDigest !== input.corpusDigest) {
      throw new Error(`Clarification evaluation corpus digest mismatch: ${item.id}`);
    }
    return evaluateClarificationCase(item, response);
  });

  const first = input.responses[0];
  if (!first) throw new Error("Clarification evaluation responses are empty");
  const metrics = createMetrics(input.cases, evaluations);
  const manualReviewComplete = evaluations.every(
    (item) => item.manualReviewPresent && item.continuationReviewPresent,
  );
  return {
    schemaVersion: 1,
    evaluationContractDigest: input.evaluationContractDigest,
    corpusDigest: input.corpusDigest,
    provider: first.provider,
    model: first.model,
    ...(first.responseModel ? { responseModel: first.responseModel } : {}),
    createdAt: new Date().toISOString(),
    caseCount: evaluations.length,
    metrics,
    cases: evaluations,
    manualReviewComplete,
    releaseEligible:
      manualReviewComplete && Object.values(metrics).every((metric) => metric.passed),
  };
}

function createMetrics(
  cases: readonly ClarificationEvaluationCase[],
  evaluations: readonly ClarificationCaseEvaluation[],
): ClarificationEvaluationReport["metrics"] {
  const thresholds = createClarificationEvaluationContract().thresholds;
  const expectedAsk = evaluations.filter((item) => item.expected === "ask");
  const actualAsk = evaluations.filter((item) => item.actual === "ask");
  const expectedProceed = evaluations.filter((item) => item.expected === "proceed");
  const skipIds = new Set(
    cases
      .filter((item) => item.category === "clarification_result" && item.id.includes("skip"))
      .map((item) => item.id),
  );
  const answeredIds = new Set(
    cases
      .filter((item) => item.category === "clarification_result" && item.id.includes("answered"))
      .map((item) => item.id),
  );
  return {
    routingAccuracy: atLeast(
      evaluations.filter((item) => item.actual === item.expected).length,
      evaluations.length,
      thresholds.routingAccuracy,
    ),
    askRecall: atLeast(
      expectedAsk.filter((item) => item.actual === "ask").length,
      expectedAsk.length,
      thresholds.askRecall,
    ),
    askPrecision: atLeast(
      actualAsk.filter((item) => item.expected === "ask").length,
      actualAsk.length,
      thresholds.askPrecision,
    ),
    unnecessaryInterruptionRate: atMost(
      expectedProceed.filter((item) => item.actual === "ask").length,
      expectedProceed.length,
      thresholds.unnecessaryInterruptionRate,
    ),
    validRequestRate: atLeast(
      actualAsk.filter((item) => item.requestValid).length,
      actualAsk.length,
      thresholds.validRequestRate,
    ),
    questionQualityRate: atLeast(
      actualAsk.filter((item) => item.questionQualityPassed).length,
      actualAsk.length,
      thresholds.questionQualityRate,
    ),
    skipContinuationRate: continuationMetric(skipIds, evaluations, thresholds.skipContinuationRate),
    answeredContinuationRate: continuationMetric(
      answeredIds,
      evaluations,
      thresholds.answeredContinuationRate,
    ),
  };
}

function continuationMetric(
  ids: ReadonlySet<string>,
  evaluations: readonly ClarificationCaseEvaluation[],
  required: number,
): EvaluationMetric {
  const selected = evaluations.filter((item) => ids.has(item.id));
  return atLeast(
    selected.filter((item) => item.actual === "proceed" && item.continuationPassed).length,
    selected.length,
    required,
  );
}

function areValidQuestions(values: readonly unknown[]): boolean {
  const ids = new Set<string>();
  for (const value of values) {
    if (!isValidQuestion(value) || ids.has(value.id)) return false;
    ids.add(value.id);
  }
  return true;
}

function isValidQuestion(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!isRecord(value)) return false;
  if (!isText(value.id) || !isText(value.question)) return false;
  if (value.type === "text") return value.options === undefined && value.allowOther === undefined;
  if (value.type !== "single" && value.type !== "multiple") return false;
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 6) {
    return false;
  }
  const optionIds = new Set<string>();
  for (const option of value.options) {
    if (!isRecord(option) || !isText(option.id) || !isText(option.label)) return false;
    if (optionIds.has(option.id)) return false;
    optionIds.add(option.id);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function atLeast(numerator: number, denominator: number, required: number): EvaluationMetric {
  return metric(numerator, denominator, required, "at_least");
}

function atMost(numerator: number, denominator: number, required: number): EvaluationMetric {
  return metric(numerator, denominator, required, "at_most");
}

function metric(
  numerator: number,
  denominator: number,
  required: number,
  comparator: EvaluationMetric["comparator"],
): EvaluationMetric {
  const value = denominator === 0 ? null : numerator / denominator;
  const passed =
    value !== null && (comparator === "at_least" ? value >= required : value <= required);
  return { numerator, denominator, value, required, comparator, passed };
}
