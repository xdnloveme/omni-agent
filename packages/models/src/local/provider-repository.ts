import type { JSONSchemaType } from "ajv";
import { resolve } from "node:path";
import { AtomicJsonFile } from "../storage/atomic-json-file";
import { containsSecretField, SchemaCompiler } from "../schema/vendor-settings";
import {
  validateEnvironmentVariables,
  validateHttpEndpoint,
  validateProviderId,
  validateUniqueModelIds,
} from "../validation/provider-definition";
import type { CompatibleModelDefinition, CompatibleProtocol } from "../providers/custom/types";

export interface LocalProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly connectionId?: string;
  readonly connectionName?: string;
  readonly baseUrl: string;
  readonly envVars: readonly string[];
  readonly protocol: CompatibleProtocol;
  readonly credentialAliases?: readonly string[];
  readonly models: readonly CompatibleModelDefinition[];
}

interface LocalProviderFileDto {
  providers: LocalProviderDefinitionDto[];
}

interface LocalProviderDefinitionDto {
  id: string;
  displayName: string;
  connectionId: string;
  connectionName: string;
  baseUrl: string;
  envVars: string[];
  protocol: CompatibleProtocol;
  credentialAliases: string[];
  models: CompatibleModelDefinitionDto[];
}

interface CompatibleModelDefinitionDto {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface LocalProviderSnapshot {
  readonly content?: string;
}

const providerFileSchema: JSONSchemaType<LocalProviderFileDto> = {
  type: "object",
  properties: {
    providers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          displayName: { type: "string", minLength: 1 },
          connectionId: { type: "string", minLength: 1 },
          connectionName: { type: "string", minLength: 1 },
          baseUrl: { type: "string", minLength: 1 },
          envVars: { type: "array", items: { type: "string", minLength: 1 } },
          protocol: {
            type: "string",
            enum: [
              "openai-completions",
              "openai-responses",
              "anthropic-messages",
              "google-generative-ai",
              "mistral-conversations",
            ],
          },
          credentialAliases: { type: "array", items: { type: "string", minLength: 1 } },
          models: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                name: { type: "string", minLength: 1 },
                contextWindow: { type: "integer", minimum: 1 },
                maxTokens: { type: "integer", minimum: 1 },
                reasoning: { type: "boolean" },
              },
              required: ["id", "name", "contextWindow", "maxTokens", "reasoning"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "id",
          "displayName",
          "connectionId",
          "connectionName",
          "baseUrl",
          "envVars",
          "protocol",
          "credentialAliases",
          "models",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["providers"],
  additionalProperties: false,
};

const fileValidator = new SchemaCompiler().compileTyped(providerFileSchema);

export class LocalProviderRepository {
  private readonly file: AtomicJsonFile<unknown>;
  private operation: Promise<void> = Promise.resolve();

  constructor(cwd = process.cwd()) {
    this.file = new AtomicJsonFile(resolve(cwd, ".omni-agent.local/providers.json"));
  }

  async list(): Promise<readonly LocalProviderDefinition[]> {
    await this.operation;
    return this.readDefinitions();
  }

  async find(id: string): Promise<LocalProviderDefinition | undefined> {
    return (await this.list()).find((definition) => definition.id === id);
  }

  upsert(definition: LocalProviderDefinition): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readDefinitions();
      const candidate = {
        providers: [...current.filter((item) => item.id !== definition.id), definition],
      };
      const validated = validateFile(candidate);
      await this.file.write(validated);
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readDefinitions();
      await this.file.write({ providers: current.filter((item) => item.id !== id) });
    });
  }

  async snapshot(): Promise<LocalProviderSnapshot> {
    await this.operation;
    return { content: await this.file.readText() };
  }

  restore(snapshot: LocalProviderSnapshot): Promise<void> {
    return this.enqueue(async () => {
      if (snapshot.content === undefined) await this.file.remove();
      else await this.file.writeText(snapshot.content);
    });
  }

  private async readDefinitions(): Promise<readonly LocalProviderDefinition[]> {
    const input = await this.file.read();
    if (input === undefined) return [];
    return validateFile(input).providers;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.operation.catch(() => undefined).then(task);
    this.operation = next.catch(() => undefined);
    return next;
  }
}

function validateFile(input: unknown): LocalProviderFileDto {
  if (containsSecretField(input)) {
    throw new Error(
      "Local provider definitions must not contain secrets; use keytar or an environment variable",
    );
  }
  let parsed: LocalProviderFileDto;
  try {
    parsed = fileValidator.validate(applyLegacyDefaults(input));
  } catch (error) {
    throw new Error(
      `Invalid local provider file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    providers: parsed.providers.map((provider, index) =>
      validateDefinition(provider, `providers[${index}]`),
    ),
  };
}

function applyLegacyDefaults(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.providers)) return input;
  return {
    ...input,
    providers: input.providers.map((provider) => {
      if (!isRecord(provider)) return provider;
      const displayName = typeof provider.displayName === "string" ? provider.displayName : "";
      return {
        ...provider,
        connectionId: provider.connectionId === undefined ? "default" : provider.connectionId,
        connectionName:
          provider.connectionName === undefined ? displayName : provider.connectionName,
        protocol: provider.protocol === undefined ? "openai-completions" : provider.protocol,
        credentialAliases:
          provider.credentialAliases === undefined ? [] : provider.credentialAliases,
        models: Array.isArray(provider.models)
          ? provider.models.map((model) => {
              if (!isRecord(model)) return model;
              return {
                ...model,
                name: model.name === undefined ? model.id : model.name,
                reasoning: model.reasoning === undefined ? false : model.reasoning,
              };
            })
          : provider.models,
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateDefinition(
  definition: LocalProviderDefinitionDto,
  path: string,
): LocalProviderDefinitionDto;
function validateDefinition(
  definition: LocalProviderDefinition,
  path: string,
): LocalProviderDefinition {
  validateProviderId(definition.id, `${path}.id`);
  validateHttpEndpoint(definition.baseUrl, `${path}.baseUrl`);
  validateEnvironmentVariables(definition.envVars, `${path}.envVars`);
  validateUniqueModelIds(definition.models, `${path}.models`);
  return {
    ...definition,
    envVars: [...new Set(definition.envVars)],
    credentialAliases: definition.credentialAliases
      ? [...new Set(definition.credentialAliases)]
      : undefined,
    models: definition.models.map((model) => ({ ...model })),
  };
}
