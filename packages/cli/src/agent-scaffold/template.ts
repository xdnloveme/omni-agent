export interface AgentScaffoldTemplateInput {
  readonly agentId: string;
  readonly displayName: string;
  readonly frameworkVersion: string;
}

export interface AgentScaffoldFile {
  readonly path: string;
  readonly content: string;
}

/** Pure renderer for the one supported, minimal Agent Package shape. */
export function renderAgentScaffold(
  input: AgentScaffoldTemplateInput,
): readonly AgentScaffoldFile[] {
  const { agentId, displayName, frameworkVersion } = input;
  const promptId = `${agentId}.default`;
  const toolComponentId = `${agentId}.echo`;
  return [
    file(
      "agent.yaml",
      `# Declarative Recipe: select components and order; keep implementations in TypeScript.
apiVersion: omni-agent/v2
kind: Agent
metadata:
  id: ${yamlString(agentId)}
  displayName: ${yamlString(displayName)}
runtime:
  blueprintApiVersion: 2
description: ${yamlString(`A minimal ${displayName} Omni Agent package.`)}
composition:
  prompt:
    profile: ${yamlString(promptId)}
    contributors: []
  tools:
    sequence:
      - tool: ${yamlString(toolComponentId)}
  capabilities: {}
`,
    ),
    file(
      "package.json",
      `${JSON.stringify(
        {
          name: `@omni-agent/agent-${agentId}`,
          version: "0.1.0",
          type: "module",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./agent.yaml": "./agent.yaml",
          },
          files: ["dist", "agent.yaml", "README.md"],
          scripts: {
            build: "tsc -p tsconfig.json",
            typecheck: "tsc -p tsconfig.json --noEmit",
          },
          dependencies: {
            "@omni-agent/app": `^${frameworkVersion}`,
            "@omni-agent/core": `^${frameworkVersion}`,
          },
          devDependencies: {
            typescript: "^5.9.0",
          },
        },
        null,
        2,
      )}\n`,
    ),
    file(
      "tsconfig.json",
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            inputConstraint: "prefer",
            declaration: true,
            declarationMap: true,
            sourceMap: true,
            rootDir: "./src",
            outDir: "./dist",
            skipLibCheck: true,
          },
          include: ["src/**/*.ts"],
          exclude: ["node_modules", "dist"],
        },
        null,
        2,
      )}\n`,
    ),
    file(
      "src/index.ts",
      `// Agent Package roots expose one Blueprint and no alternate Factory path.
export { agentBlueprint } from "./blueprint.js";
`,
    ),
    file(
      "src/blueprint.ts",
      `import type { AgentBlueprint, AgentBlueprintContext } from "@omni-agent/app";
import { defineAgent } from "@omni-agent/core";
import { createTools, toolDescriptors } from "./components/tool-catalog.js";

const promptProfile = {
  id: ${tsString(promptId)},
  displayName: ${tsString(`${displayName} default prompt`)},
  description: ${tsString(`Core instructions for ${displayName}.`)},
} as const;

export const agentBlueprint = {
  descriptor: {
    promptProfiles: [promptProfile],
    promptContributors: [],
    toolBundles: [],
    tools: toolDescriptors,
    capabilities: { skills: [], artifactRecovery: [] },
  },
  build(context: AgentBlueprintContext) {
    if (context.composition.prompt.profileId !== promptProfile.id) {
      throw new Error(
        \`Prompt implementation is missing: \${context.composition.prompt.profileId}\`,
      );
    }
    const tools = createTools(context.composition.tools.componentIds);
    return {
      extension: {
        manifest: { id: context.manifest.metadata.id, version: "0.1.0", apiVersion: 1 },
        contributions: {
          tools: [...tools],
          agents: [
            {
              definition: defineAgent({
                id: context.manifest.metadata.id,
                description: context.manifest.description,
                instructions: ${tsString(`You are ${displayName}. Follow the user's requests.`)},
              }),
              tools: { include: tools.map(({ name }) => name) },
            },
          ],
        },
      },
      capabilities: {},
    };
  },
} satisfies AgentBlueprint;
`,
    ),
    file(
      "src/components/tool-catalog.ts",
      `import type { ToolComponentDescriptor } from "@omni-agent/app";
import type { AgentToolDefinition } from "@omni-agent/core";

interface ToolComponent {
  readonly descriptor: ToolComponentDescriptor;
  create(): AgentToolDefinition;
}

// Descriptor and Factory share one definition; agent.yaml remains the selection owner.
const components: readonly ToolComponent[] = [
  {
    descriptor: {
      id: ${tsString(toolComponentId)},
      displayName: "Echo text",
      description: "Returns supplied text without external side effects.",
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
      async execute(input: Record<string, unknown>) {
        return {
          content: [{ type: "text", text: String(input.text) }],
          isError: false,
        };
      },
    }),
  },
];

const componentsById = new Map(
  components.map((component) => [component.descriptor.id, component]),
);

export const toolDescriptors = components.map(({ descriptor }) => descriptor);

export function createTools(componentIds: readonly string[]): readonly AgentToolDefinition[] {
  return componentIds.map((id) => {
    const component = componentsById.get(id);
    if (!component) throw new Error(\`Tool implementation is missing: \${id}\`);
    return component.create();
  });
}
`,
    ),
    file(
      "README.md",
      `# ${displayName}

Minimal Omni Agent package generated by \`omni agent create\`.

\`agent.yaml\` is the only component-selection source. Component implementations live beside
their descriptors under \`src/\`; the Blueprint only consumes the resolved composition.

\`\`\`bash
npm install
npm run typecheck
npm run build
npm install --prefix ~/.omni-agent/agents "$PWD"
omni agent validate ${agentId}
omni agent plan ${agentId}
omni run ${agentId}
\`\`\`

After changing \`agent.yaml\` or TypeScript implementations, rebuild and reinstall the local
package before starting a new Agent instance. YAML changes affect the next assembly; they do not
hot-mutate an already running Agent instance.
`,
    ),
  ];
}

function file(path: string, content: string): AgentScaffoldFile {
  return { path, content };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function tsString(value: string): string {
  return JSON.stringify(value);
}
