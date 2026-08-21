import type { AgentBlueprint } from "@omni-agent/app";
import {
  financialPromptContributorDescriptors,
  financialPromptProfileDescriptors,
  resolveFinancialPrompt,
} from "./components/prompt-catalog";
import {
  createFinancialTools,
  financialToolBundleDescriptors,
  financialToolDescriptors,
} from "./components/tool-catalog";
import { createFinancialAnalysisExtension } from "./extension";

export const agentBlueprint = {
  descriptor: {
    promptProfiles: financialPromptProfileDescriptors,
    promptContributors: financialPromptContributorDescriptors,
    toolBundles: financialToolBundleDescriptors,
    tools: financialToolDescriptors,
    capabilities: { skills: [], artifactRecovery: [] },
  },
  build(context) {
    const prompt = resolveFinancialPrompt(
      context.composition.prompt.profileId,
      context.composition.prompt.contributorIds,
    );
    const tools = createFinancialTools(context.composition.tools.componentIds, context.interaction);
    return {
      extension: createFinancialAnalysisExtension(context.manifest, tools, prompt),
      capabilities: {},
    };
  },
} satisfies AgentBlueprint;
