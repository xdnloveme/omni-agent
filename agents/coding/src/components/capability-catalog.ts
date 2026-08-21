import type {
  AgentCapabilities,
  ComponentDescriptor,
  DependentComponentDescriptor,
  ResolvedAgentComposition,
} from "@omni-agent/app";
import { SkillRuntime } from "@omni-agent/core";

const skillsDefinition = {
  descriptor: {
    id: "skills.local",
    displayName: "Local Skills",
    description: "Discovers and loads Skills available to the active workspace.",
  } satisfies ComponentDescriptor,
  async create(cwd: string) {
    const runtime = new SkillRuntime({ cwd });
    await runtime.initialize();
    return runtime;
  },
};

const artifactRecoveryDefinition = {
  descriptor: {
    id: "context.file-read-recovery",
    displayName: "File read artifact recovery",
    description: "Directs the agent to file_read when a complete file-backed result is required.",
    requiresTools: ["coding.file-read"],
  } satisfies DependentComponentDescriptor,
  create() {
    return {
      toolName: "file_read",
      instruction: "Use file_read on the path when the complete result is needed.",
    };
  },
};

export const codingSkillsCapabilityDescriptors = [skillsDefinition.descriptor];
export const codingArtifactRecoveryDescriptors = [artifactRecoveryDefinition.descriptor];

export async function createCodingCapabilities(
  composition: ResolvedAgentComposition,
  cwd: string,
): Promise<{ readonly capabilities: AgentCapabilities; readonly skills?: SkillRuntime }> {
  let skills: SkillRuntime | undefined;
  if (composition.capabilities.skillsId === skillsDefinition.descriptor.id) {
    skills = await skillsDefinition.create(cwd);
  } else if (composition.capabilities.skillsId !== undefined) {
    throw new Error(
      `Coding Skills capability implementation is missing: ${composition.capabilities.skillsId}`,
    );
  }

  const artifactRecoveryId = composition.capabilities.artifactRecoveryId;
  if (
    artifactRecoveryId !== undefined &&
    artifactRecoveryId !== artifactRecoveryDefinition.descriptor.id
  ) {
    throw new Error(`Coding Context capability implementation is missing: ${artifactRecoveryId}`);
  }
  return {
    skills,
    capabilities: {
      ...(skills ? { skills: { runtime: skills } } : {}),
      ...(artifactRecoveryId
        ? { context: { artifactRecovery: artifactRecoveryDefinition.create() } }
        : {}),
    },
  };
}
