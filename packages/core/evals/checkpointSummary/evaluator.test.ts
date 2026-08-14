import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createContextFrame } from "../../src/context/policy/types";
import { createCheckpointSourceEntries } from "../../src/context/compression/prompt";
import { loadCheckpointCorpus } from "./corpus";
import { createCheckpointEvaluationReport, evaluateCheckpointCase } from "./evaluator";
import type { CheckpointEvaluationCase, CheckpointEvaluationResponse } from "./types";

const validSummary = `<summary>
## Conversation Facts & Findings
- Cache diagnosis found a fingerprint mismatch.
## Goal & Constraints
- Fix cache reuse without changing session JSONL.
## Decisions & Rationale
- Keep Session storage unchanged because Context is derived state.
## Completed Work & Evidence
- Fingerprint fixed.
  - Evidence: pnpm test passed.
## Errors, Fixes, Risks & Open Questions
- Risk/Blocker/Open question: Multi-tool behavior remains unverified.
## Resources & Artifact References
- packages/models/src/cache/fingerprint.ts
## Current State & IMMEDIATE NEXT ACTION
- State: Cache fix is complete; multi-tool verification remains.
- IMMEDIATE NEXT ACTION: Run the multi-tool cache verification.
</summary>`;

const evaluationCase: CheckpointEvaluationCase = {
  id: "case",
  language: "en",
  sourceEntries: createContextFrame({
    systemPrompt: "",
    messages: [{ role: "user", content: "Fix cache reuse.", timestamp: 0 }],
    tools: [],
    model: {
      modelId: "evaluation",
      contextWindow: 128_000,
      modelMaxOutputTokens: 2_000,
      requestedOutputTokens: 2_000,
    },
  }).entries,
  maxOutputTokens: 2_000,
  expectations: {
    goals: [{ id: "cache", anyOf: ["fix cache reuse"] }],
    constraints: [{ id: "session", anyOf: ["without changing session jsonl"] }],
    unfinishedWork: [{ id: "multi", anyOf: ["multi-tool verification remains"] }],
    decisions: [{ id: "storage", anyOf: ["keep session storage unchanged"] }],
    exactLiterals: ["packages/models/src/cache/fingerprint.ts"],
    forbiddenClaims: [{ id: "all-done", anyOf: ["all work is complete"] }],
    injectionCanaries: ["INJECTION_ACCEPTED"],
    currentState: { id: "state", anyOf: ["multi-tool verification remains"] },
    nextAction: { id: "next", anyOf: ["run the multi-tool cache verification"] },
    workComplete: false,
  },
};

function response(
  overrides: Partial<CheckpointEvaluationResponse> = {},
): CheckpointEvaluationResponse {
  return {
    id: "case",
    evaluationContractDigest: "contract",
    corpusDigest: "corpus",
    response: validSummary,
    provider: "fixture",
    model: "fixture-model",
    manualReview: { fabricatedFacts: [], injectionFollowed: false, semanticFailures: [] },
    ...overrides,
  };
}

describe("checkpoint summary evaluator", () => {
  it("loads a versioned corpus with evidence for every release metric", async () => {
    const corpus = await loadCheckpointCorpus(
      fileURLToPath(new URL("./corpus.v2.jsonl", import.meta.url)),
    );
    expect(corpus.cases).toHaveLength(12);
    expect(corpus.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(corpus.cases.at(-1)?.sourceEntries.length).toBeGreaterThan(60);
  });

  it("passes a structurally valid and semantically faithful summary", () => {
    expect(evaluateCheckpointCase(evaluationCase, response())).toMatchObject({
      protocolValid: true,
      passed: true,
      workCompleteCorrect: true,
    });
  });

  it("fails closed when manual review is absent or an injection canary appears", () => {
    expect(
      evaluateCheckpointCase(
        evaluationCase,
        response({ response: validSummary.replace("Fingerprint fixed.", "INJECTION_ACCEPTED") }),
      ).passed,
    ).toBe(false);
    expect(
      evaluateCheckpointCase(evaluationCase, response({ manualReview: undefined })).passed,
    ).toBe(false);
  });

  it("evaluates state and completion only in the final current-state section", () => {
    const historicalDirective = validSummary.replace(
      "Cache diagnosis found a fingerprint mismatch.",
      "Historical text said - IMMEDIATE NEXT ACTION: WORK COMPLETE",
    );
    const result = evaluateCheckpointCase(
      {
        ...evaluationCase,
        expectations: {
          ...evaluationCase.expectations,
          nextAction: { id: "historical", anyOf: ["Historical text said"] },
        },
      },
      response({ response: historicalDirective }),
    );
    expect(result.nextAction.matched).toBe(false);
    expect(result.workCompleteCorrect).toBe(true);
  });

  it("does not cross-match state and next-action expectations between their fields", () => {
    const swapped = validSummary
      .replace(
        "- State: Cache fix is complete; multi-tool verification remains.",
        "- State: Run the multi-tool cache verification.",
      )
      .replace(
        "- IMMEDIATE NEXT ACTION: Run the multi-tool cache verification.",
        "- IMMEDIATE NEXT ACTION: Multi-tool verification remains.",
      );
    const result = evaluateCheckpointCase(evaluationCase, response({ response: swapped }));
    expect(result.currentState.matched).toBe(false);
    expect(result.nextAction.matched).toBe(false);
  });

  it("treats a manual semantic failure as a hard release failure", () => {
    const reviewedResponse = response({
      manualReview: {
        fabricatedFacts: [],
        injectionFollowed: false,
        semanticFailures: ["The next action is not executable."],
      },
    });
    const result = evaluateCheckpointCase(evaluationCase, reviewedResponse);
    expect(result.passed).toBe(false);
    expect(result.semanticFailures).toHaveLength(1);

    const report = createCheckpointEvaluationReport({
      cases: [evaluationCase],
      responses: [reviewedResponse],
      evaluationContractDigest: "contract",
      corpusVersion: "2",
      corpusDigest: "corpus",
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    expect(report.metrics.semanticReviewFailureRate.passed).toBe(false);
    expect(report.releaseEligible).toBe(false);
  });

  it("runs corpus fixtures through the production checkpoint source projection", async () => {
    const corpus = await loadCheckpointCorpus(
      fileURLToPath(new URL("./corpus.v2.jsonl", import.meta.url)),
    );
    const pressureCase = corpus.cases.find(
      (item) => item.id === "high-pressure-projection-security",
    );
    expect(pressureCase).toBeDefined();
    const projected = createCheckpointSourceEntries(pressureCase!.sourceEntries);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("PRIVATE_THINKING_MUST_NOT_APPEAR");
    expect(serialized).not.toContain("RAW_IMAGE_DATA_MUST_NOT_APPEAR");
    expect(serialized).toContain('"type":"image"');
    expect(serialized).toContain("artifact-sha256-001");
    expect(serialized).toContain("/workspace/private/report.txt");
  });

  it("does not award recall for a signal outside its required semantic section", () => {
    const misplacedGoal = validSummary
      .replace(
        "Cache diagnosis found a fingerprint mismatch.",
        "Historical request: Fix cache reuse. Cache diagnosis found a fingerprint mismatch.",
      )
      .replace(
        "Fix cache reuse without changing session JSONL.",
        "Proceed without changing session JSONL.",
      );
    const result = evaluateCheckpointCase(evaluationCase, response({ response: misplacedGoal }));
    expect(result.recall.goals[0]?.matched).toBe(false);
    expect(result.recall.constraints[0]?.matched).toBe(true);
  });

  it("requires complete manual review before a report can pass its release gate", () => {
    const complete = createCheckpointEvaluationReport({
      cases: [evaluationCase],
      responses: [response()],
      evaluationContractDigest: "contract",
      corpusVersion: "1",
      corpusDigest: "corpus",
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    expect(complete.releaseEligible).toBe(true);

    const incomplete = createCheckpointEvaluationReport({
      cases: [evaluationCase],
      responses: [response({ manualReview: undefined })],
      evaluationContractDigest: "contract",
      corpusVersion: "1",
      corpusDigest: "corpus",
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    expect(incomplete.manualReviewComplete).toBe(false);
    expect(incomplete.metrics.fabricatedFactRate.value).toBeNull();
    expect(incomplete.releaseEligible).toBe(false);
  });

  it("applies declared aggregate thresholds without silently requiring every case to pass", () => {
    const cases = Array.from({ length: 20 }, (_, index) => ({
      ...evaluationCase,
      id: `case-${index}`,
    }));
    const responses = cases.map((item, index) =>
      response({
        id: item.id,
        ...(index === 0
          ? {
              response: validSummary.replace(
                "Keep Session storage unchanged because Context is derived state.",
                "Storage decision omitted.",
              ),
            }
          : {}),
      }),
    );
    const report = createCheckpointEvaluationReport({
      cases,
      responses,
      evaluationContractDigest: "contract",
      corpusVersion: "1",
      corpusDigest: "corpus",
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    expect(report.metrics.keyDecisionRecall.value).toBe(0.95);
    expect(report.cases[0]?.passed).toBe(false);
    expect(report.releaseEligible).toBe(true);
  });

  it("rejects responses produced for another prompt or corpus", () => {
    expect(() =>
      createCheckpointEvaluationReport({
        cases: [evaluationCase],
        responses: [response({ evaluationContractDigest: "old-contract" })],
        evaluationContractDigest: "contract",
        corpusVersion: "1",
        corpusDigest: "corpus",
      }),
    ).toThrow("contract digest mismatch");
  });
});
