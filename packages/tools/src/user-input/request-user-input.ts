import {
  InteractionError,
  validateInteractionResponse,
  type AgentToolDefinition,
  type InteractionSurfacePort,
  type ToolResult,
} from "@omni-agent/core";
import type { RequestUserInputArgs } from "./contracts";
import { mapUserInputInteraction } from "./interaction-mapper";
import { createRequestUserInputPreflight } from "./request-user-input-preflight";
import { requestUserInputSchema } from "./request-user-input-schema";
import { UserInputResponseError, validateUserInputResponse } from "./response-validator";
import { formatUserInputResult } from "./result-formatter";

export function createRequestUserInputTool(
  interaction: InteractionSurfacePort,
): AgentToolDefinition {
  return {
    name: "request_user_input",
    description:
      "Ask the current user 1 to 3 concise decision questions when missing information would materially change scope, compatibility, risk, or the result. Investigate discoverable facts first. Do not use for ordinary implementation details or runtime permission.",
    strict: true,
    schema: requestUserInputSchema,
    preflight: createRequestUserInputPreflight(),
    authorization: {
      kind: "trusted",
      reason: "Requests information from the current user without external side effects",
    },
    execution: { kind: "host" },
    timeout: { kind: "none" },
    scheduling: { batch: "turn_barrier" },
    context: { retention: "conversation" },
    async execute(input, context): Promise<ToolResult> {
      const args = input as unknown as RequestUserInputArgs;
      const request = mapUserInputInteraction(args, crypto.randomUUID());
      const startedAt = Date.now();
      try {
        const response = await interaction.request(request, context.signal);
        validateInteractionResponse(request, response);
        validateUserInputResponse(args, response);
        return formatUserInputResult(args, response, Math.max(0, Date.now() - startedAt));
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const code =
          error instanceof UserInputResponseError
            ? error.code
            : error instanceof InteractionError
              ? error.code
              : "invalid_user_input_response";
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          meta: { code, retryable: code === "interaction_busy" },
        };
      }
    },
  };
}
