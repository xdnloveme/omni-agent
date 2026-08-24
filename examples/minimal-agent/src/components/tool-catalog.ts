import type { ToolComponentDescriptor } from "@omni-agent/app";
import type { AgentToolDefinition } from "@omni-agent/core";

interface ToolComponent {
  readonly descriptor: ToolComponentDescriptor;
  create(): AgentToolDefinition;
}

// Descriptor and Factory are co-located so the Catalog has one source of truth.
const components: readonly ToolComponent[] = [
  {
    descriptor: {
      id: "minimal.echo",
      displayName: "Echo text",
      description: "Returns the supplied text without external side effects.",
      toolName: "echo_text",
    },
    create: () => ({
      name: "echo_text",
      description: "Return the supplied text.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } },
      },
      timeout: { kind: "none" },
      access: { kind: "internal" },
      execution: { kind: "in_process" },
      async execute(input) {
        return {
          content: [{ type: "text", text: String(input.text) }],
          isError: false,
        };
      },
    }),
  },
];

const componentsById = new Map(components.map((component) => [component.descriptor.id, component]));

export const toolDescriptors = components.map(({ descriptor }) => descriptor);

export function createTools(componentIds: readonly string[]): readonly AgentToolDefinition[] {
  return componentIds.map((id) => {
    const component = componentsById.get(id);
    if (!component) throw new Error(`Minimal Tool implementation is missing: ${id}`);
    return component.create();
  });
}
