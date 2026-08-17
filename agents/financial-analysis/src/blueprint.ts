import type { AgentBlueprint } from "@omni-agent/app";
import { createFinancialAnalysisExtension } from "./extension";

export const agentBlueprint = {
  id: "financial-analysis",
  build(context) {
    return {
      id: "financial-analysis",
      extension: createFinancialAnalysisExtension(context.interaction),
      capabilities: {},
    };
  },
} satisfies AgentBlueprint;
