import { outputReadTool } from "@omni-agent/tools";
import type { ToolComponentDescriptor } from "@omni-agent/app";
import type { AgentToolDefinition, InteractionSurfacePort, SkillRuntime } from "@omni-agent/core";
import { fileEditTool, fileReadTool, fileWriteTool } from "@omni-agent/tools/filesystem";
import { globTool, grepTool } from "@omni-agent/tools/search";
import { bashTool } from "@omni-agent/tools/shell";
import { createRequestUserInputTool } from "@omni-agent/tools/user-input";
import { webFetchTool, webSearchTool } from "@omni-agent/tools/web";

interface CodingToolFactoryContext {
  readonly interaction: InteractionSurfacePort;
  readonly skills?: SkillRuntime;
}

interface CodingToolDefinition {
  readonly descriptor: ToolComponentDescriptor;
  create(context: CodingToolFactoryContext): AgentToolDefinition;
}

// Package-private Catalog: each Component's public facts and Factory are co-located.
const toolDefinitions: readonly CodingToolDefinition[] = [
  definition(
    "runtime.output-read",
    "Read saved output",
    "Read retained tool results from this Session.",
    outputReadTool,
  ),
  definition(
    "coding.bash",
    "Shell",
    "Run shell commands within the active execution boundary.",
    bashTool,
  ),
  definition(
    "coding.file-read",
    "Read file",
    "Read bounded file content within the active execution boundary.",
    fileReadTool,
  ),
  definition(
    "coding.file-edit",
    "Edit file",
    "Apply explicit text edits to an accessible file.",
    fileEditTool,
  ),
  definition(
    "coding.file-write",
    "Write file",
    "Write complete content to an accessible file.",
    fileWriteTool,
  ),
  definition("coding.glob", "Discover files", "Find accessible files by glob pattern.", globTool),
  definition("coding.grep", "Search files", "Search accessible file content.", grepTool),
  definition(
    "research.web-fetch",
    "Fetch web resource",
    "Fetch a public web resource.",
    webFetchTool,
  ),
  definition("research.web-search", "Search the web", "Search the public web.", webSearchTool),
  {
    descriptor: {
      id: "interaction.request-user-input",
      displayName: "Request user input",
      description: "Request structured clarification from the current user.",
      toolName: "request_user_input",
    },
    create: ({ interaction }) => createRequestUserInputTool(interaction),
  },
  {
    descriptor: {
      id: "skills.read",
      displayName: "Read Skill",
      description: "Load the complete instructions for a selected local Skill.",
      toolName: "skill_read",
      requiresCapabilities: ["skills.local"],
    },
    create({ skills }) {
      if (!skills) throw new Error("skills.read requires skills.local");
      return skills.tool();
    },
  },
];

export const codingToolDescriptors = toolDefinitions.map(({ descriptor }) => descriptor);

export function createCodingTools(
  componentIds: readonly string[],
  interaction: InteractionSurfacePort,
  skills: SkillRuntime | undefined,
): readonly AgentToolDefinition[] {
  return componentIds.map((id) => {
    const definition = toolDefinitions.find(({ descriptor }) => descriptor.id === id);
    if (!definition) throw new Error(`Coding Tool implementation is missing: ${id}`);
    return definition.create({ interaction, skills });
  });
}

function definition(
  id: string,
  displayName: string,
  description: string,
  tool: AgentToolDefinition,
): CodingToolDefinition {
  return {
    descriptor: { id, displayName, description, toolName: tool.name },
    create: () => tool,
  };
}
