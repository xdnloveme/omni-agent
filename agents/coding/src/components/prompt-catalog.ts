import {
  agentsMdContributor,
  composeStableSystemPrompt,
  createSkillsContributor,
  type SkillRuntime,
  type SystemPromptContributor,
} from "@omni-agent/core";
import type { ComponentDescriptor, DependentComponentDescriptor } from "@omni-agent/app";
import { CODING_SYSTEM_PROMPT } from "../prompt";

interface PromptProfileDefinition {
  readonly descriptor: ComponentDescriptor;
  readonly content: string;
}

interface PromptContributorDefinition {
  readonly descriptor: DependentComponentDescriptor;
  create(skills: SkillRuntime | undefined): SystemPromptContributor;
}

// Package-private Catalog: Descriptor and implementation share one definition.
// Component selection remains exclusively owned by agent.yaml and the Planner.
const promptProfiles: readonly PromptProfileDefinition[] = [
  {
    descriptor: {
      id: "coding.default",
      displayName: "Default coding prompt",
      description: "Core instructions for the interactive coding agent.",
    },
    content: CODING_SYSTEM_PROMPT,
  },
];

const promptContributors: readonly PromptContributorDefinition[] = [
  {
    descriptor: {
      id: "workspace.agents-md",
      displayName: "Workspace instructions",
      description: "Adds applicable AGENTS.md instructions from the active workspace.",
    },
    create: () => agentsMdContributor,
  },
  {
    descriptor: {
      id: "skills.catalog",
      displayName: "Skills catalog",
      description: "Adds the available local Skills catalog to the system prompt.",
      requiresCapabilities: ["skills.local"],
    },
    create(skills) {
      if (!skills) throw new Error("skills.catalog requires skills.local");
      return createSkillsContributor(skills.registry);
    },
  },
];

export const codingPromptProfileDescriptors = promptProfiles.map(({ descriptor }) => descriptor);
export const codingPromptContributorDescriptors = promptContributors.map(
  ({ descriptor }) => descriptor,
);

export function createCodingSystemPrompt(
  profileId: string,
  contributorIds: readonly string[],
  cwd: string,
  skills: SkillRuntime | undefined,
): () => Promise<string> {
  const profile = promptProfiles.find(({ descriptor }) => descriptor.id === profileId);
  if (!profile) throw new Error(`Coding Prompt profile implementation is missing: ${profileId}`);
  const contributors = contributorIds.map((id) => {
    const definition = promptContributors.find(({ descriptor }) => descriptor.id === id);
    if (!definition) throw new Error(`Coding Prompt contributor implementation is missing: ${id}`);
    return definition.create(skills);
  });
  return async () => {
    const dynamic = await Promise.all(contributors.map((contributor) => contributor(cwd)));
    return composeStableSystemPrompt(profile.content, dynamic);
  };
}
