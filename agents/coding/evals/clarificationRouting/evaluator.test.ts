import { describe, expect, it } from "vitest";
import { createClarificationEvaluationReport, evaluateClarificationCase } from "./evaluator";
import type { ClarificationEvaluationCase, ClarificationEvaluationResponse } from "./types";

const askCase: ClarificationEvaluationCase = {
  id: "ask",
  language: "en",
  category: "material_choice",
  messages: [{ role: "user", content: "Choose a compatibility policy." }],
  expected: "ask",
};

function response(
  id: string,
  toolCalls: ClarificationEvaluationResponse["toolCalls"] = [],
): ClarificationEvaluationResponse {
  return {
    id,
    evaluationContractDigest: "contract",
    corpusDigest: "corpus",
    provider: "fixture",
    model: "fixture-model",
    toolCalls,
    manualReview: {
      decisionFocused: true,
      optionsMutuallyExclusive: true,
      recommendationAndTradeoffs: true,
      customInputHandledCorrectly: true,
    },
  };
}

const validRequest = {
  name: "request_user_input",
  arguments: {
    questions: [
      {
        id: "compatibility",
        question: "Which compatibility policy should be used?",
        type: "single",
        options: [
          { id: "keep", label: "Keep compatibility" },
          { id: "break", label: "Allow a breaking change" },
        ],
      },
    ],
  },
} as const;

describe("clarification routing evaluator", () => {
  it("recognizes one valid, manually reviewed clarification request", () => {
    expect(evaluateClarificationCase(askCase, response("ask", [validRequest]))).toMatchObject({
      actual: "ask",
      requestCount: 1,
      questionCount: 1,
      requestValid: true,
      questionQualityPassed: true,
      passed: true,
    });
  });

  it("rejects duplicated or malformed clarification requests", () => {
    expect(
      evaluateClarificationCase(askCase, response("ask", [validRequest, validRequest])),
    ).toMatchObject({ requestValid: false, passed: false });
    expect(
      evaluateClarificationCase(
        askCase,
        response("ask", [
          { name: "request_user_input", arguments: { questions: [{ type: "text" }] } },
        ]),
      ),
    ).toMatchObject({ requestValid: false, passed: false });
    expect(
      evaluateClarificationCase(
        askCase,
        response("ask", [
          {
            name: "request_user_input",
            arguments: {
              questions: [validRequest.arguments.questions[0], validRequest.arguments.questions[0]],
            },
          },
        ]),
      ),
    ).toMatchObject({ requestValid: false, passed: false });
  });

  it("computes routing, continuation and quality release metrics", () => {
    const proceedCase: ClarificationEvaluationCase = {
      ...askCase,
      id: "proceed-after-skip",
      category: "clarification_result",
      expected: "proceed",
    };
    const answeredCase: ClarificationEvaluationCase = {
      ...proceedCase,
      id: "proceed-after-answered",
    };
    expect(evaluateClarificationCase(proceedCase, response(proceedCase.id))).toMatchObject({
      actual: "proceed",
      continuationReviewPresent: false,
      continuationPassed: false,
      passed: false,
    });
    const report = createClarificationEvaluationReport({
      cases: [askCase, proceedCase, answeredCase],
      responses: [
        response("ask", [validRequest]),
        {
          ...response(proceedCase.id),
          continuationReview: { continuedAppropriately: true },
        },
        {
          ...response(answeredCase.id),
          continuationReview: { continuedAppropriately: true },
        },
      ],
      evaluationContractDigest: "contract",
      corpusDigest: "corpus",
    });
    expect(report.releaseEligible).toBe(true);
    expect(report.metrics).toMatchObject({
      routingAccuracy: { value: 1 },
      askRecall: { value: 1 },
      askPrecision: { value: 1 },
      unnecessaryInterruptionRate: { value: 0 },
      skipContinuationRate: { value: 1 },
      answeredContinuationRate: { value: 1 },
    });
  });
});
