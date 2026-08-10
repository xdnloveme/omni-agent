import type { AgentFactory } from "@omni-agent/app";
import { financialAnalysisExtension } from "./extension";

export const agentFactory = {
  create() {
    return {
      agentId: "financial-analysis",
      extension: financialAnalysisExtension,
    };
  },
} satisfies AgentFactory<unknown>;
