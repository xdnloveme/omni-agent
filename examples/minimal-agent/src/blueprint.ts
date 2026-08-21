import type { AgentBlueprint } from "@omni-agent/app";
import { defineAgent } from "@omni-agent/core";
import { createTools, toolDescriptors } from "./components/tool-catalog";

const promptProfile = {
  id: "minimal.default",
  displayName: "Minimal default prompt",
  description: "Core instructions for the minimal example Agent.",
} as const;

export const agentBlueprint = {
  descriptor: {
    promptProfiles: [promptProfile],
    promptContributors: [],
    toolBundles: [],
    tools: toolDescriptors,
    capabilities: { skills: [], artifactRecovery: [] },
  },
  build(context) {
    if (context.composition.prompt.profileId !== promptProfile.id) {
      throw new Error(
        `Minimal Prompt implementation is missing: ${context.composition.prompt.profileId}`,
      );
    }
    const tools = createTools(context.composition.tools.componentIds);
    return {
      extension: {
        manifest: { id: context.manifest.metadata.id, version: "0.0.1", apiVersion: 1 },
        contributions: {
          tools: [...tools],
          agents: [
            {
              definition: defineAgent({
                id: context.manifest.metadata.id,
                description: context.manifest.description,
                instructions:
                  "You are a minimal example agent. Use echo_text when asked to echo text.",
              }),
              tools: { include: tools.map(({ name }) => name) },
            },
          ],
        },
      },
      capabilities: {},
    };
  },
} satisfies AgentBlueprint;
