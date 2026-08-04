import type { AgentExtension } from "@omni-agent/app";
import {
  createSkillsContributor,
  defaultContributors,
  type SkillRuntime,
  type SystemPromptContributor,
} from "@omni-agent/core";
import { localCodingToolset, webResearchToolset } from "@omni-agent/tools/toolsets";
import { createCodingAgent } from "./agent";
import { CODING_SYSTEM_PROMPT } from "./prompt";

export interface CodingExtensionBundle {
  extension: AgentExtension;
  buildSystemPrompt(): Promise<string>;
}

export function createCodingExtension(
  skillRuntime: SkillRuntime,
  cwd = process.cwd(),
): CodingExtensionBundle {
  const contributors: SystemPromptContributor[] = [
    ...defaultContributors,
    createSkillsContributor(skillRuntime.registry),
  ];
  const buildSystemPrompt = async () => {
    const sections = [CODING_SYSTEM_PROMPT.trim()];
    const dynamic = await Promise.all(contributors.map((contributor) => contributor(cwd)));
    for (const section of dynamic) if (section) sections.push(section);
    return sections.join("\n\n");
  };
  const tools = [
    ...localCodingToolset,
    ...webResearchToolset,
    skillRuntime.tool(),
  ];
  return {
    buildSystemPrompt,
    extension: {
      manifest: { id: "coding", version: "0.0.1", apiVersion: 1 },
      contributions: {
        tools,
        agents: [{
          definition: createCodingAgent(buildSystemPrompt),
          tools: { include: tools.map((tool) => tool.name) },
        }],
      },
    },
  };
}
