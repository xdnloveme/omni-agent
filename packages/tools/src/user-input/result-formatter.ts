import type { InteractionResponse, ToolResult } from "@omni-agent/core";
import type { RequestUserInputArgs } from "./contracts";

export function formatUserInputResult(
  args: RequestUserInputArgs,
  response: InteractionResponse,
  waitMs: number,
): ToolResult {
  const skipped = response.kind === "dismissed";
  if (skipped) {
    return {
      isError: false,
      content: [
        {
          type: "text",
          text: "The user skipped this input request.",
        },
      ],
      meta: {
        interaction: { version: 1, requestId: response.requestId, outcome: "skipped", answers: {} },
        waitMs,
      },
    };
  }
  const lines = ["User input responses:"];
  const answers: Record<string, unknown> = {};
  for (const question of args.questions) {
    const value = response.values[question.id];
    if (!value) continue;
    answers[question.id] = value;
    let rendered = "";
    if (value.type === "text") rendered = value.text;
    if (value.type === "single") {
      rendered = value.otherText ?? optionLabel(question, value.optionId) ?? "";
    }
    if (value.type === "multiple") {
      rendered = [
        ...value.optionIds.map((id) => optionLabel(question, id) ?? id),
        ...(value.otherText ? [value.otherText] : []),
      ].join(", ");
    }
    lines.push(`- [${question.id}] ${question.question}: ${rendered}`);
  }
  return {
    isError: false,
    content: [{ type: "text", text: lines.join("\n") }],
    meta: {
      interaction: { version: 1, requestId: response.requestId, outcome: "submitted", answers },
      waitMs,
    },
  };
}

function optionLabel(
  question: RequestUserInputArgs["questions"][number],
  optionId: string | undefined,
): string | undefined {
  if (!optionId || question.type === "text") return undefined;
  return question.options.find((option) => option.id === optionId)?.label;
}
