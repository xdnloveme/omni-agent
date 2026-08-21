import type { AgentBlueprint } from "@omni-agent/app";
import {
  codingArtifactRecoveryDescriptors,
  codingSkillsCapabilityDescriptors,
  createCodingCapabilities,
} from "./components/capability-catalog";
import {
  codingPromptContributorDescriptors,
  codingPromptProfileDescriptors,
  createCodingSystemPrompt,
} from "./components/prompt-catalog";
import { codingToolBundleDescriptors } from "./components/tool-bundles";
import { codingToolDescriptors, createCodingTools } from "./components/tool-catalog";
import { createCodingExtension } from "./extension";

export const agentBlueprint = {
  descriptor: {
    promptProfiles: codingPromptProfileDescriptors,
    promptContributors: codingPromptContributorDescriptors,
    toolBundles: codingToolBundleDescriptors,
    tools: codingToolDescriptors,
    capabilities: {
      skills: codingSkillsCapabilityDescriptors,
      artifactRecovery: codingArtifactRecoveryDescriptors,
    },
  },
  async build(context) {
    const { capabilities, skills } = await createCodingCapabilities(
      context.composition,
      context.cwd,
    );
    const buildSystemPrompt = createCodingSystemPrompt(
      context.composition.prompt.profileId,
      context.composition.prompt.contributorIds,
      context.cwd,
      skills,
    );
    const tools = createCodingTools(
      context.composition.tools.componentIds,
      context.interaction,
      skills,
    );
    const extension = createCodingExtension(context.manifest, tools, buildSystemPrompt);
    return {
      extension: extension.extension,
      capabilities,
    };
  },
} satisfies AgentBlueprint;
