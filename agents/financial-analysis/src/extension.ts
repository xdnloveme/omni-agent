import type { AgentExtension } from "@omni-agent/app";
import type { InteractionSurfacePort } from "@omni-agent/core";
import { createRequestUserInputTool } from "@omni-agent/tools/user-input";
import { financialAnalysisAgent } from "./agents/financial-analysis-agent";
import { computeTechnicalIndicatorsTool } from "./tools/compute-indicators";

export function createFinancialAnalysisExtension(
  interaction: InteractionSurfacePort,
): AgentExtension {
  const requestUserInput = createRequestUserInputTool(interaction);
  return {
    manifest: { id: "financial-analysis", version: "0.0.1", apiVersion: 1 },
    contributions: {
      tools: [computeTechnicalIndicatorsTool, requestUserInput],
      agents: [
        {
          definition: financialAnalysisAgent,
          tools: { include: [computeTechnicalIndicatorsTool.name, requestUserInput.name] },
        },
      ],
    },
  };
}
