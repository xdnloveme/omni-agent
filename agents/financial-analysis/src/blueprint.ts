import type { AgentBlueprint } from "@omni-agent/app";
import { financialAnalysisExtension } from "./extension";

export const agentBlueprint = {
  id: "financial-analysis",
  build() {
    return {
      id: "financial-analysis",
      extension: financialAnalysisExtension,
      capabilities: {},
    };
  },
} satisfies AgentBlueprint;
