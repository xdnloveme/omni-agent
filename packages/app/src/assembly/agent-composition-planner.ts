import type {
  AgentBlueprintDescriptor,
  AgentCompositionRecipe,
  ComponentDescriptor,
  DependentComponentDescriptor,
  ResolvedAgentComposition,
  ToolComponentDescriptor,
} from "./contracts";
import { deepFreeze } from "./deep-freeze";

export type AgentCompositionErrorCode =
  | "unknown_component"
  | "invalid_bundle_reference"
  | "duplicate_component"
  | "duplicate_tool_name"
  | "missing_capability_dependency"
  | "missing_tool_dependency";

export class AgentCompositionPlanningError extends Error {
  constructor(
    readonly code: AgentCompositionErrorCode,
    message: string,
    readonly path: string,
    readonly componentId?: string,
  ) {
    super(message);
    this.name = "AgentCompositionPlanningError";
  }
}

export class AgentCompositionPlanner {
  plan(
    recipe: AgentCompositionRecipe,
    descriptor: AgentBlueprintDescriptor,
  ): ResolvedAgentComposition {
    const promptProfiles = index(descriptor.promptProfiles);
    const promptContributors = index(descriptor.promptContributors);
    const toolBundles = index(descriptor.toolBundles);
    const tools = index(descriptor.tools);
    const skills = index(descriptor.capabilities.skills);
    const artifactRecovery = index(descriptor.capabilities.artifactRecovery);

    requireComponent(
      promptProfiles,
      recipe.prompt.profile,
      "Prompt profile",
      "composition.prompt.profile",
    );
    assertUnique(
      recipe.prompt.contributors.map((id, index) => ({
        id,
        path: `composition.prompt.contributors[${index}]`,
      })),
      "Prompt contributor",
    );
    for (const [position, id] of recipe.prompt.contributors.entries()) {
      requireComponent(
        promptContributors,
        id,
        "Prompt contributor",
        `composition.prompt.contributors[${position}]`,
      );
    }

    const selected: Array<{ id: string; path: string }> = [];
    const selectedBundles: Array<{ id: string; path: string }> = [];
    for (const [position, entry] of recipe.tools.sequence.entries()) {
      if (entry.bundle !== undefined) {
        const path = `composition.tools.sequence[${position}].bundle`;
        selectedBundles.push({ id: entry.bundle, path });
        const bundle = requireComponent(
          toolBundles,
          entry.bundle,
          "Tool bundle",
          path,
          "invalid_bundle_reference",
        );
        for (const id of bundle.tools) selected.push({ id, path });
      } else {
        selected.push({ id: entry.tool, path: `composition.tools.sequence[${position}].tool` });
      }
    }
    assertUnique(selectedBundles, "Tool bundle");
    assertUnique(selected, "Resolved Tool component");

    const selectedTools = selected.map(({ id, path }) => requireComponent(tools, id, "Tool", path));
    assertUniqueToolNames(selectedTools, selected);

    const skillsId = recipe.capabilities.skills;
    if (skillsId !== undefined) {
      requireComponent(skills, skillsId, "Skills capability", "composition.capabilities.skills");
    }
    const artifactRecoveryId = recipe.capabilities.context?.artifactRecovery;
    if (artifactRecoveryId !== undefined) {
      requireComponent(
        artifactRecovery,
        artifactRecoveryId,
        "Artifact Recovery capability",
        "composition.capabilities.context.artifactRecovery",
      );
    }

    const selectedCapabilityIds = new Set(
      [skillsId, artifactRecoveryId].filter((id): id is string => id !== undefined),
    );
    const selectedToolIds = new Set(selected.map(({ id }) => id));
    const dependencies: Array<{ component: DependentComponentDescriptor; path: string }> = [
      ...recipe.prompt.contributors.map((id, index) => ({
        component: promptContributors.get(id)!,
        path: `composition.prompt.contributors[${index}]`,
      })),
      ...selectedTools.map((component, index) => ({ component, path: selected[index]!.path })),
      ...(artifactRecoveryId
        ? [
            {
              component: artifactRecovery.get(artifactRecoveryId)!,
              path: "composition.capabilities.context.artifactRecovery",
            },
          ]
        : []),
    ];
    for (const { component, path } of dependencies) {
      for (const id of component.requiresCapabilities ?? []) {
        if (!selectedCapabilityIds.has(id)) {
          throw new AgentCompositionPlanningError(
            "missing_capability_dependency",
            `Component ${component.id} requires Capability ${id}`,
            path,
            component.id,
          );
        }
      }
      for (const id of component.requiresTools ?? []) {
        if (!selectedToolIds.has(id)) {
          throw new AgentCompositionPlanningError(
            "missing_tool_dependency",
            `Component ${component.id} requires Tool component ${id}`,
            path,
            component.id,
          );
        }
      }
    }

    return deepFreeze({
      prompt: {
        profileId: recipe.prompt.profile,
        contributorIds: [...recipe.prompt.contributors],
      },
      tools: {
        componentIds: selected.map(({ id }) => id),
        toolNames: selectedTools.map(({ toolName }) => toolName),
      },
      capabilities: { skillsId, artifactRecoveryId },
    });
  }
}

function index<T extends ComponentDescriptor>(values: readonly T[]): ReadonlyMap<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function requireComponent<T>(
  values: ReadonlyMap<string, T>,
  id: string,
  label: string,
  path: string,
  code: AgentCompositionErrorCode = "unknown_component",
): T {
  const value = values.get(id);
  if (!value) {
    throw new AgentCompositionPlanningError(
      code,
      `${label} is not declared by the Blueprint: ${id}`,
      path,
      id,
    );
  }
  return value;
}

function assertUnique(values: readonly { id: string; path: string }[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new AgentCompositionPlanningError(
        "duplicate_component",
        `${label} is selected more than once: ${value.id}`,
        value.path,
        value.id,
      );
    }
    seen.add(value.id);
  }
}

function assertUniqueToolNames(
  tools: readonly ToolComponentDescriptor[],
  selected: readonly { id: string; path: string }[],
): void {
  const seen = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (seen.has(tool.toolName)) {
      throw new AgentCompositionPlanningError(
        "duplicate_tool_name",
        `Resolved Tool name is exposed more than once: ${tool.toolName}`,
        selected[index]!.path,
        tool.id,
      );
    }
    seen.add(tool.toolName);
  }
}
