import { defineAgent } from "@omni-agent/core";
import type { AgentManifest } from "@omni-agent/app";

export function createFinancialAnalysisAgent(manifest: AgentManifest, instructions: string) {
  return defineAgent<{ cwd: string }>({
    id: manifest.metadata.id,
    description: manifest.description,
    instructions,
  });
}
