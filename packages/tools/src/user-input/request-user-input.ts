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
import { formatUserInputResult } from "./result-formatter";

export function createRequestUserInputTool(
  interaction: InteractionSurfacePort,
): AgentToolDefinition {
  return {
    name: "request_user_input",
    description:
      "Collect 1 to 3 structured decision answers from the current user using single-select, multi-select, or text fields. Every predefined option requires a stable id and non-empty user-visible label. Returns submitted answers or a skipped outcome. This tool does not change runtime access boundaries.",
    strict: true,
    schema: requestUserInputSchema,
    preflight: createRequestUserInputPreflight(),
    access: { kind: "internal" },
    execution: { kind: "in_process" },
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
        return formatUserInputResult(args, response, Math.max(0, Date.now() - startedAt));
      } catch (error) {
        if (!(error instanceof InteractionError)) throw error;
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
          meta: { code: error.code, retryable: error.code === "interaction_busy" },
        };
      }
    },
  };
}
