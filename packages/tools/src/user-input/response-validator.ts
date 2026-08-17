import type { InteractionResponse } from "@omni-agent/core";
import type { RequestUserInputArgs } from "./contracts";

export class UserInputResponseError extends Error {
  readonly code = "invalid_user_input_response" as const;

  constructor(message: string) {
    super(message);
    this.name = "UserInputResponseError";
  }
}

export function validateUserInputResponse(
  args: RequestUserInputArgs,
  response: InteractionResponse,
): void {
  if (response.kind === "dismissed" || response.actionId === "skip") return;
  if (response.actionId !== "submit") invalid("Unknown clarification action");
  for (const question of args.questions) {
    const value = response.values[question.id];
    if (!value) {
      if (question.required ?? true) invalid(`Required question was not answered: ${question.id}`);
      continue;
    }
    if (value.type === "single" && !value.optionId && !value.otherText?.trim()) {
      if (question.required ?? true) invalid(`Required question was not answered: ${question.id}`);
    }
    if (value.type === "multiple" && value.optionIds.length === 0 && !value.otherText?.trim()) {
      if (question.required ?? true) invalid(`Required question was not answered: ${question.id}`);
    }
    if (value.type === "text" && !value.text.trim() && (question.required ?? true)) {
      invalid(`Required question was not answered: ${question.id}`);
    }
  }
}

function invalid(message: string): never {
  throw new UserInputResponseError(message);
}
