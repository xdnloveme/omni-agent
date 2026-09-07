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
import { InstructionScopeGate } from "./instructions";

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
    const scopeGate = await InstructionScopeGate.create(context.cwd);
    const { capabilities, skills } = await createCodingCapabilities(
      context.composition,
      context.cwd,
    );
    const buildSystemPrompt = createCodingSystemPrompt(
      context.composition.prompt.profileId,
      context.composition.prompt.contributorIds,
      context.cwd,
      skills,
      context.execution.getMode,
      scopeGate.contributor,
    );
    const tools = createCodingTools(
      context.composition.tools.componentIds,
      context.interaction,
      skills,
    );
    const extension = createCodingExtension(context.manifest, tools, buildSystemPrompt, scopeGate);
    return {
      extension: extension.extension,
      capabilities,
    };
  },
} satisfies AgentBlueprint;
