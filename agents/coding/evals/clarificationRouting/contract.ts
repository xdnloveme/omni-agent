import { createHash } from "node:crypto";
import { CODING_SYSTEM_PROMPT } from "../../src/prompt";
import { createRequestUserInputTool } from "@omni-agent/tools/user-input";

export const CLARIFICATION_EVALUATION_SCHEMA_VERSION = 1;

export function createClarificationEvaluationContract() {
  const tool = createRequestUserInputTool({
    request: async () => {
      throw new Error("Evaluation tool definitions are never executed");
    },
  });
  return {
    schemaVersion: CLARIFICATION_EVALUATION_SCHEMA_VERSION,
    systemPrompt: CODING_SYSTEM_PROMPT,
    tool: {
      name: tool.name,
      description: tool.description,
      inputConstraint: tool.inputConstraint,
      parameters: tool.schema,
    },
    thresholds: {
      routingAccuracy: 0.9,
      askRecall: 0.9,
      askPrecision: 0.9,
      unnecessaryInterruptionRate: 0.1,
      validRequestRate: 1,
      questionQualityRate: 1,
      skipContinuationRate: 1,
      answeredContinuationRate: 1,
    },
  } as const;
}

export function createClarificationEvaluationContractDigest(): string {
  return digest(createClarificationEvaluationContract());
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
