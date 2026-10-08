import type { AgentExtension, AgentManifest } from "@omni-agent/app";
import type { AgentToolDefinition } from "@omni-agent/core";
import { createCodingAgent } from "./agent";

export interface CodingExtensionBundle {
  extension: AgentExtension;
  buildSystemPrompt(): Promise<string>;
}

export function createCodingExtension(
  manifest: AgentManifest,
  tools: readonly AgentToolDefinition[],
  buildSystemPrompt: () => Promise<string>,
  scopeGate: import("@omni-agent/core").ToolBatchPreparationPolicy,
): CodingExtensionBundle {
  return {
    buildSystemPrompt,
    extension: {
      manifest: { id: manifest.metadata.id, version: "0.0.1", apiVersion: 1 },
      contributions: {
        tools: [...tools],
        agents: [
          {
            definition: createCodingAgent(manifest, buildSystemPrompt, scopeGate),
            tools: { include: tools.map((tool) => tool.name) },
          },
        ],
      },
    },
  };
}
