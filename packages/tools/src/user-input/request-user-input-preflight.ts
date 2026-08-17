import type { ToolPreflightDescriptor, ToolResult } from "@omni-agent/core";
import type { RequestUserInputArgs, UserInputQuestion } from "./contracts";

export function createRequestUserInputPreflight(): ToolPreflightDescriptor {
  return {
    async validate(input) {
      try {
        validateRequestUserInputArgs(input as unknown as RequestUserInputArgs);
        return { outcome: "ready" };
      } catch (error) {
        return { outcome: "error", result: invalidRequestResult(error) };
      }
    },
  };
}

export function validateRequestUserInputArgs(args: RequestUserInputArgs): void {
  const questionIds = new Set<string>();
  for (const question of args.questions) {
    requireText(question.id, "question id");
    requireText(question.question, `question ${question.id}`);
    if (questionIds.has(question.id)) throw new Error(`Duplicate question id: ${question.id}`);
    questionIds.add(question.id);
    validateQuestion(question);
  }
}

function validateQuestion(question: UserInputQuestion): void {
  if (question.type === "text") {
    if ("options" in question || "allowOther" in question) {
      throw new Error(`Text question ${question.id} cannot declare options or allowOther`);
    }
    return;
  }
  if (!Array.isArray(question.options)) {
    throw new Error(`Selection question ${question.id} must declare options`);
  }
  const optionIds = new Set<string>();
  for (const option of question.options) {
    requireText(option.id, `option id in ${question.id}`);
    requireText(option.label, `option ${option.id} label`);
    if (optionIds.has(option.id))
      throw new Error(`Duplicate option id in ${question.id}: ${option.id}`);
    optionIds.add(option.id);
  }
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be blank`);
}

function invalidRequestResult(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    meta: { code: "invalid_user_input_request", retryable: false },
  };
}
