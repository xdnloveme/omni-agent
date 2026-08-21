import type { AgentExtension, AgentManifest } from "@omni-agent/app";
import type { AgentToolDefinition } from "@omni-agent/core";
import { createFinancialAnalysisAgent } from "./agents/financial-analysis-agent";

export function createFinancialAnalysisExtension(
  manifest: AgentManifest,
  tools: readonly AgentToolDefinition[],
  prompt: string,
): AgentExtension {
  return {
    manifest: { id: manifest.metadata.id, version: "0.0.1", apiVersion: 1 },
    contributions: {
      tools: [...tools],
      agents: [
        {
          definition: createFinancialAnalysisAgent(manifest, prompt),
          tools: { include: tools.map(({ name }) => name) },
        },
      ],
    },
  };
}
