import type { ToolBundleDescriptor, ToolComponentDescriptor } from "@omni-agent/app";
import type { AgentToolDefinition, InteractionSurfacePort } from "@omni-agent/core";
import { createRequestUserInputTool } from "@omni-agent/tools/user-input";
import { computeTechnicalIndicatorsTool } from "../tools/compute-indicators";

interface FinancialToolDefinition {
  readonly descriptor: ToolComponentDescriptor;
  create(interaction: InteractionSurfacePort): AgentToolDefinition;
}

const toolDefinitions: readonly FinancialToolDefinition[] = [
  {
    descriptor: {
      id: "financial-analysis.indicators",
      displayName: "Compute technical indicators",
      description: "Compute deterministic technical indicators from supplied market data.",
      toolName: computeTechnicalIndicatorsTool.name,
    },
    create: () => computeTechnicalIndicatorsTool,
  },
  {
    descriptor: {
      id: "interaction.request-user-input",
      displayName: "Request user input",
      description: "Request structured clarification from the current user.",
      toolName: "request_user_input",
    },
    create: (interaction) => createRequestUserInputTool(interaction),
  },
];

export const financialToolDescriptors = toolDefinitions.map(({ descriptor }) => descriptor);
export const financialToolBundleDescriptors: readonly ToolBundleDescriptor[] = [
  {
    id: "financial-analysis.readonly",
    displayName: "Read-only financial analysis tools",
    description: "Deterministic analysis tools with no trading or order execution capability.",
    tools: ["financial-analysis.indicators"],
  },
];

export function createFinancialTools(
  componentIds: readonly string[],
  interaction: InteractionSurfacePort,
): readonly AgentToolDefinition[] {
  return componentIds.map((id) => {
    const definition = toolDefinitions.find(({ descriptor }) => descriptor.id === id);
    if (!definition) throw new Error(`Financial Tool implementation is missing: ${id}`);
    return definition.create(interaction);
  });
}
