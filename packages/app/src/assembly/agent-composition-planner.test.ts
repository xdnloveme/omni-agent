import { describe, expect, it } from "vitest";
import { validateAgentBlueprintDescriptor } from "./agent-blueprint-descriptor-validator";
import { AgentCompositionPlanner } from "./agent-composition-planner";
import type { AgentBlueprintDescriptor, AgentCompositionRecipe } from "./contracts";

const metadata = (id: string) => ({ id, displayName: id, description: `${id} description` });

const descriptor: AgentBlueprintDescriptor = {
  promptProfiles: [metadata("coding.default")],
  promptContributors: [
    metadata("workspace.agents-md"),
    { ...metadata("skills.catalog"), requiresCapabilities: ["skills.local"] },
  ],
  toolBundles: [
    {
      ...metadata("coding.workspace"),
      tools: ["coding.file-read", "coding.bash"],
    },
  ],
  tools: [
    { ...metadata("coding.file-read"), toolName: "file_read" },
    { ...metadata("coding.bash"), toolName: "bash" },
    {
      ...metadata("skills.read"),
      toolName: "skill_read",
      requiresCapabilities: ["skills.local"],
    },
  ],
  capabilities: {
    skills: [metadata("skills.local")],
    artifactRecovery: [
      {
        ...metadata("context.file-read-recovery"),
        requiresTools: ["coding.file-read"],
      },
    ],
  },
};

const recipe: AgentCompositionRecipe = {
  prompt: {
    profile: "coding.default",
    contributors: ["workspace.agents-md", "skills.catalog"],
  },
  tools: {
    sequence: [{ bundle: "coding.workspace" }, { tool: "skills.read" }],
  },
  capabilities: {
    skills: "skills.local",
    context: { artifactRecovery: "context.file-read-recovery" },
  },
};

describe("AgentCompositionPlanner", () => {
  it("expands interleaved Bundle and Tool entries into an immutable composition", () => {
    const resolved = new AgentCompositionPlanner().plan(recipe, descriptor);

    expect(resolved.tools).toEqual({
      componentIds: ["coding.file-read", "coding.bash", "skills.read"],
      toolNames: ["file_read", "bash", "skill_read"],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.tools.componentIds)).toBe(true);
  });

  it.each([
    [
      "unknown component",
      { ...recipe, prompt: { ...recipe.prompt, profile: "coding.missing" } },
      "unknown_component",
    ],
    [
      "invalid Bundle reference",
      {
        ...recipe,
        tools: { sequence: [{ bundle: "coding.missing" as const }] },
      },
      "invalid_bundle_reference",
    ],
    [
      "duplicate component",
      {
        ...recipe,
        tools: {
          sequence: [
            { bundle: "coding.workspace" as const },
            { tool: "coding.file-read" as const },
          ],
        },
      },
      "duplicate_component",
    ],
    [
      "missing capability dependency",
      { ...recipe, capabilities: { context: recipe.capabilities.context } },
      "missing_capability_dependency",
    ],
    [
      "missing Tool dependency",
      {
        ...recipe,
        tools: { sequence: [{ tool: "skills.read" as const }] },
      },
      "missing_tool_dependency",
    ],
  ])("rejects %s with a structured error", (_label, invalid, code) => {
    expect(() => new AgentCompositionPlanner().plan(invalid, descriptor)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects malformed Descriptors before semantic planning", () => {
    expect(() =>
      validateAgentBlueprintDescriptor({
        ...descriptor,
        tools: [...descriptor.tools, descriptor.tools[0]],
      }),
    ).toThrow("duplicate");
  });
});
