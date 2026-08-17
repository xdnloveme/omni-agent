import type { InteractionRequest } from "@omni-agent/core";
import type { RequestUserInputArgs } from "./contracts";

export function mapUserInputInteraction(
  args: RequestUserInputArgs,
  requestId: string,
): InteractionRequest {
  return {
    requestId,
    title: "Clarification needed",
    message: args.context,
    dismissLabel: "Skip",
    fields: args.questions.map((question) => {
      if (question.type === "text") {
        return {
          type: "text" as const,
          id: question.id,
          label: question.question,
          description: question.description,
          placeholder: question.placeholder,
          required: question.required ?? true,
        };
      }
      return {
        type: question.type,
        id: question.id,
        label: question.question,
        description: question.description,
        options: question.options,
        required: question.required ?? true,
        allowOther: question.allowOther,
      };
    }),
    completion: {
      type: "explicit",
      actions: [
        { id: "submit", label: "Submit", tone: "positive" },
        { id: "skip", label: "Skip" },
      ],
    },
  };
}
