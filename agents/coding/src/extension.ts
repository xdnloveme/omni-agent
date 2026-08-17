import type { AgentExtension } from "@omni-agent/app";
import {
  createSkillsContributor,
  composeStableSystemPrompt,
  defaultContributors,
  type SkillRuntime,
  type SystemPromptContributor,
  type InteractionSurfacePort,
} from "@omni-agent/core";
import { createRequestUserInputTool } from "@omni-agent/tools/user-input";
import { localCodingToolset, webResearchToolset } from "@omni-agent/tools/toolsets";
import { createCodingAgent } from "./agent";
import { CODING_SYSTEM_PROMPT } from "./prompt";

export interface CodingExtensionBundle {
  extension: AgentExtension;
  buildSystemPrompt(): Promise<string>;
}

export function createCodingExtension(
  skillRuntime: SkillRuntime,
  interaction: InteractionSurfacePort,
  cwd = process.cwd(),
): CodingExtensionBundle {
  const contributors: SystemPromptContributor[] = [
    ...defaultContributors,
    createSkillsContributor(skillRuntime.registry),
  ];
  const buildSystemPrompt = async () => {
    const dynamic = await Promise.all(contributors.map((contributor) => contributor(cwd)));
    return composeStableSystemPrompt(CODING_SYSTEM_PROMPT, dynamic);
  };
  const tools = [
    ...localCodingToolset,
    ...webResearchToolset,
    createRequestUserInputTool(interaction),
    skillRuntime.tool(),
  ];
  return {
    buildSystemPrompt,
    extension: {
      manifest: { id: "coding", version: "0.0.1", apiVersion: 1 },
      contributions: {
        tools,
        agents: [
          {
            definition: createCodingAgent(buildSystemPrompt),
            tools: { include: tools.map((tool) => tool.name) },
          },
        ],
      },
    },
  };
}
