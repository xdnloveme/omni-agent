import {
  composeStableSystemPrompt,
  createSkillsContributor,
  type ExecutionMode,
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
  create(
    skills: SkillRuntime | undefined,
    projectInstructions: SystemPromptContributor,
  ): SystemPromptContributor;
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
    create: (_skills, projectInstructions) => projectInstructions,
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

const EXECUTION_MODE_GUIDANCE: Readonly<Record<ExecutionMode, string>> = {
  controlled:
    "Operate within the workspace by default. Use file and search tools directly for external paths; the runtime derives the smallest useful access scope and may ask the user to add it to this workspace's controlled boundary. For Bash, declare every filesystem path outside the workspace or its approved boundary in sandbox_scope, including a bounded exact or subtree scope for dynamically determined paths, and declare network needs there. You may request access, but only the user can approve it. Do not attempt to bypass filesystem boundaries through temporary paths, symlinks, or shell wrappers.",
  autonomous:
    "You may request external access per Bash call through sandbox_scope. Declare the smallest useful read/write paths and exact scheme/host/port network_targets, use exact scope for sensitive reads, and never request credential writes or exfiltration.",
  unrestricted:
    "Commands run directly on the host without sandbox access restrictions. Runtime schema validation, timeout, cancellation, output limits, and domain validation still apply. Avoid destructive or unrelated host changes unless the user's request clearly requires them.",
};

export const codingPromptProfileDescriptors = promptProfiles.map(({ descriptor }) => descriptor);
export const codingPromptContributorDescriptors = promptContributors.map(
  ({ descriptor }) => descriptor,
);

export function createCodingSystemPrompt(
  profileId: string,
  contributorIds: readonly string[],
  cwd: string,
  skills: SkillRuntime | undefined,
  getExecutionMode: () => Promise<ExecutionMode>,
  projectInstructions: SystemPromptContributor,
): () => Promise<string> {
  const profile = promptProfiles.find(({ descriptor }) => descriptor.id === profileId);
  if (!profile) throw new Error(`Coding Prompt profile implementation is missing: ${profileId}`);
  const contributors = contributorIds.map((id) => {
    const definition = promptContributors.find(({ descriptor }) => descriptor.id === id);
    if (!definition) throw new Error(`Coding Prompt contributor implementation is missing: ${id}`);
    return definition.create(skills, projectInstructions);
  });
  return async () => {
    const dynamic = await Promise.all(contributors.map((contributor) => contributor(cwd)));
    return composeStableSystemPrompt(profile.content, [
      executionModePrompt(await getExecutionMode()),
      ...dynamic,
    ]);
  };
}

function executionModePrompt(mode: ExecutionMode): string {
  return `# Execution Mode\n\nCurrent mode: ${mode}. ${EXECUTION_MODE_GUIDANCE[mode]}`;
}
