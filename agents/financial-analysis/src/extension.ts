import type { AgentExtension } from "@omni-agent/app";
import { financialAnalysisAgent } from "./agents/financial-analysis-agent";
import { computeTechnicalIndicatorsTool } from "./tools/compute-indicators";

export const financialAnalysisExtension: AgentExtension = {
  manifest: { id: "financial-analysis", version: "0.0.1", apiVersion: 1 },
  contributions: {
    tools: [computeTechnicalIndicatorsTool],
    agents: [
      {
        definition: financialAnalysisAgent,
        tools: { include: [computeTechnicalIndicatorsTool.name] },
      },
    ],
  },
};
