import type { JSONSchemaType } from "ajv";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CompatibleModelDefinition,
  CompatibleProtocol,
  CompatibleProviderCompat,
} from "../providers/custom/types";
import { containsSecretField, SchemaCompiler } from "../schema/vendor-settings";
import { AtomicJsonFile } from "../storage/atomic-json-file";
import {
  validateEnvironmentVariables,
  validateHttpEndpoint,
  validateProviderId,
  validateUniqueModelIds,
} from "../validation/provider-definition";

export type ConfigurationScope = "global" | "project";

export interface ProviderConnectionDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly envVars: readonly string[];
  readonly protocol: CompatibleProtocol;
  readonly compat?: CompatibleProviderCompat;
  readonly credentialAliases?: readonly string[];
  readonly models: readonly CompatibleModelDefinition[];
}

export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly connections: readonly ProviderConnectionDefinition[];
}

interface ProviderConfigFileDto {
  version: 1;
  vendors: ProviderDefinitionDto[];
}

interface ProviderDefinitionDto {
  id: string;
  displayName: string;
  connections: ProviderConnectionDefinitionDto[];
}

interface ProviderConnectionDefinitionDto {
  id: string;
  displayName: string;
  providerId: string;
  baseUrl: string;
  envVars: string[];
  protocol: CompatibleProtocol;
  compat?: CompatibleProviderCompat;
  credentialAliases: string[];
  models: CompatibleModelDefinitionDto[];
}

interface CompatibleModelDefinitionDto {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  supportsStrictMode?: boolean;
}

export interface ProviderSnapshot {
  readonly scope: ConfigurationScope;
  readonly content?: string;
}

export interface ProviderRepositoryOptions {
  readonly cwd?: string;
  readonly globalDirectory?: string;
  readonly projectFile?: string;
}

const PROJECT_PROVIDERS_FILE = "omni.providers.json";

const providerFileSchema: JSONSchemaType<ProviderConfigFileDto> = {
  type: "object",
  properties: {
    version: { type: "integer", const: 1 },
    vendors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          displayName: { type: "string", minLength: 1 },
          connections: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                displayName: { type: "string", minLength: 1 },
                providerId: { type: "string", minLength: 1 },
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
                compat: {
                  type: "object",
                  nullable: true,
                  properties: {
                    supportsStrictMode: { type: "boolean", nullable: true },
                    supportsUsageInStreaming: { type: "boolean", nullable: true },
                    sendSessionAffinityHeaders: { type: "boolean", nullable: true },
                    sessionAffinityFormat: {
                      type: "string",
                      enum: ["openai", "openai-nosession", "openrouter"],
                      nullable: true,
                    },
                    supportsLongCacheRetention: { type: "boolean", nullable: true },
                    cacheControlFormat: {
                      type: "string",
                      enum: ["anthropic"],
                      nullable: true,
                    },
                  },
                  required: [],
                  additionalProperties: false,
                },
                credentialAliases: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
                models: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string", minLength: 1 },
                      name: { type: "string", minLength: 1 },
                      contextWindow: { type: "integer", minimum: 1 },
                      maxTokens: { type: "integer", minimum: 1 },
                      reasoning: { type: "boolean" },
                      supportsStrictMode: { type: "boolean", nullable: true },
                    },
                    required: ["id", "name", "contextWindow", "maxTokens", "reasoning"],
                    additionalProperties: false,
                  },
                },
              },
              required: [
                "id",
                "displayName",
                "providerId",
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
        required: ["id", "displayName", "connections"],
        additionalProperties: false,
      },
    },
  },
  required: ["version", "vendors"],
  additionalProperties: false,
};

const fileValidator = new SchemaCompiler().compileTyped(providerFileSchema);

export class ProviderRepository {
  private readonly global: ProviderFileRepository;
  private readonly project: ProviderFileRepository;

  constructor(options: ProviderRepositoryOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    this.global = new ProviderFileRepository(
      join(options.globalDirectory ?? join(homedir(), ".omni-agent"), "providers.json"),
      "global",
    );
    this.project = new ProviderFileRepository(
      resolve(cwd, options.projectFile ?? PROJECT_PROVIDERS_FILE),
      "project",
    );
  }

  async list(): Promise<readonly ProviderDefinition[]> {
    const [global, project] = await Promise.all([this.global.list(), this.project.list()]);
    return mergeProviderDefinitions(global, project);
  }

  async previewUpsert(
    definition: ProviderDefinition,
    options: { scope?: ConfigurationScope } = {},
  ): Promise<ProviderDefinition> {
    const scope = options.scope ?? "project";
    const [global, project] = await Promise.all([this.global.list(), this.project.list()]);
    const target = scope === "global" ? global : project;
    const updated = [...target.filter((item) => item.id !== definition.id), definition];
    const effective = mergeProviderDefinitions(
      scope === "global" ? updated : global,
      scope === "project" ? updated : project,
    ).find((item) => item.id === definition.id);
    if (!effective) throw new Error(`Provider preview failed: ${definition.id}`);
    return effective;
  }

  async upsert(
    definition: ProviderDefinition,
    options: { scope?: ConfigurationScope } = {},
  ): Promise<void> {
    await this.previewUpsert(definition, options);
    await this.layer(options.scope).upsert(definition);
  }

  snapshot(scope: ConfigurationScope = "project"): Promise<ProviderSnapshot> {
    return this.layer(scope).snapshot();
  }

  restore(snapshot: ProviderSnapshot): Promise<void> {
    return this.layer(snapshot.scope).restore(snapshot);
  }

  private layer(scope: ConfigurationScope = "project"): ProviderFileRepository {
    return scope === "global" ? this.global : this.project;
  }
}

class ProviderFileRepository {
  private readonly file: AtomicJsonFile<unknown>;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    path: string,
    private readonly scope: ConfigurationScope,
  ) {
    this.file = new AtomicJsonFile(path);
  }

  async list(): Promise<readonly ProviderDefinition[]> {
    await this.operation;
    const input = await this.file.read();
    return input === undefined ? [] : validateFile(input).vendors;
  }

  upsert(definition: ProviderDefinition): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.listWithoutWaiting();
      const candidate = {
        version: 1 as const,
        vendors: [...current.filter((item) => item.id !== definition.id), definition],
      };
      await this.file.write(validateFile(candidate));
    });
  }

  async snapshot(): Promise<ProviderSnapshot> {
    await this.operation;
    return { scope: this.scope, content: await this.file.readText() };
  }

  restore(snapshot: ProviderSnapshot): Promise<void> {
    if (snapshot.scope !== this.scope) throw new Error("Provider snapshot scope mismatch");
    return this.enqueue(async () => {
      if (snapshot.content === undefined) await this.file.remove();
      else await this.file.writeText(snapshot.content);
    });
  }

  private async listWithoutWaiting(): Promise<readonly ProviderDefinition[]> {
    const input = await this.file.read();
    return input === undefined ? [] : validateFile(input).vendors;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.operation.catch(() => undefined).then(task);
    this.operation = next.catch(() => undefined);
    return next;
  }
}

function mergeProviderDefinitions(
  global: readonly ProviderDefinition[],
  project: readonly ProviderDefinition[],
): ProviderDefinition[] {
  const merged = new Map(global.map((vendor) => [vendor.id, vendor]));
  for (const projectVendor of project) {
    const globalVendor = merged.get(projectVendor.id);
    if (!globalVendor) {
      merged.set(projectVendor.id, projectVendor);
      continue;
    }
    const connections = new Map(
      globalVendor.connections.map((connection) => [connection.id, connection]),
    );
    for (const connection of projectVendor.connections) connections.set(connection.id, connection);
    merged.set(projectVendor.id, {
      ...globalVendor,
      ...projectVendor,
      connections: [...connections.values()],
    });
  }
  return validateDefinitions([...merged.values()], "effective providers");
}

function validateFile(input: unknown): ProviderConfigFileDto {
  if (containsSecretField(input)) {
    throw new Error(
      "Provider definitions must not contain secrets; use keytar or an environment variable",
    );
  }
  let parsed: ProviderConfigFileDto;
  try {
    parsed = fileValidator.validate(applyDefaults(input));
  } catch (error) {
    throw new Error(
      `Invalid provider file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    version: 1,
    vendors: validateDefinitions(parsed.vendors, "vendors") as ProviderDefinitionDto[],
  };
}

function validateDefinitions(
  definitions: readonly ProviderDefinition[],
  path: string,
): ProviderDefinition[] {
  const vendorIds = new Set<string>();
  const providerIds = new Set<string>();
  return definitions.map((vendor, vendorIndex) => {
    validateProviderId(vendor.id, `${path}[${vendorIndex}].id`);
    if (vendorIds.has(vendor.id)) throw new Error(`${path} contains duplicate vendor ids`);
    if (vendor.connections.length === 0) {
      throw new Error(`${path}[${vendorIndex}].connections must not be empty`);
    }
    vendorIds.add(vendor.id);
    const connectionIds = new Set<string>();
    const connections = vendor.connections.map((connection, connectionIndex) => {
      const connectionPath = `${path}[${vendorIndex}].connections[${connectionIndex}]`;
      validateProviderId(connection.id, `${connectionPath}.id`);
      validateProviderId(connection.providerId, `${connectionPath}.providerId`);
      if (connectionIds.has(connection.id)) {
        throw new Error(`${path}[${vendorIndex}].connections contains duplicate connection ids`);
      }
      if (providerIds.has(connection.providerId)) {
        throw new Error(
          `Effective providers contain duplicate provider id: ${connection.providerId}`,
        );
      }
      connectionIds.add(connection.id);
      providerIds.add(connection.providerId);
      validateHttpEndpoint(connection.baseUrl, `${connectionPath}.baseUrl`);
      validateCompatibleProviderCompat(connection, connectionPath);
      for (const model of connection.models) {
        if (model.supportsStrictMode !== undefined && typeof model.supportsStrictMode !== "boolean")
          throw new Error(`${connectionPath}.models.supportsStrictMode must be boolean`);
      }
      validateEnvironmentVariables(connection.envVars, `${connectionPath}.envVars`);
      validateUniqueModelIds(connection.models, `${connectionPath}.models`);
      return {
        ...connection,
        envVars: [...new Set(connection.envVars)],
        credentialAliases: [...new Set(connection.credentialAliases ?? [])],
        models: connection.models.map((model) => ({ ...model })),
      };
    });
    return { ...vendor, connections };
  });
}

function validateCompatibleProviderCompat(
  connection: ProviderConnectionDefinition,
  path: string,
): void {
  const compat = (connection as { readonly compat?: unknown }).compat;
  if (compat === undefined) return;
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    throw new Error(`${path}.compat must be an object`);
  }
  const allowed = new Set<keyof CompatibleProviderCompat>(
    connection.protocol === "openai-completions"
      ? [
          "supportsStrictMode",
          "supportsUsageInStreaming",
          "sendSessionAffinityHeaders",
          "sessionAffinityFormat",
          "supportsLongCacheRetention",
          "cacheControlFormat",
        ]
      : connection.protocol === "openai-responses"
        ? ["supportsStrictMode", "sessionAffinityFormat", "supportsLongCacheRetention"]
        : connection.protocol === "anthropic-messages"
          ? ["supportsStrictMode", "sendSessionAffinityHeaders", "supportsLongCacheRetention"]
          : ["supportsStrictMode"],
  );
  for (const [rawKey, value] of Object.entries(compat)) {
    const key = rawKey as keyof CompatibleProviderCompat;
    if (!allowed.has(key)) {
      throw new Error(`${path}.compat.${key} is not supported by ${connection.protocol}`);
    }
    if (value === null) throw new Error(`${path}.compat.${key} must not be null`);
  }
}

function applyDefaults(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.vendors)) return input;
  return {
    ...input,
    vendors: input.vendors.map((vendor) => {
      if (!isRecord(vendor) || !Array.isArray(vendor.connections)) return vendor;
      return {
        ...vendor,
        connections: vendor.connections.map((connection) => {
          if (!isRecord(connection)) return connection;
          return {
            ...connection,
            credentialAliases:
              connection.credentialAliases === undefined ? [] : connection.credentialAliases,
            models: Array.isArray(connection.models)
              ? connection.models.map((model) => {
                  if (!isRecord(model)) return model;
                  return {
                    ...model,
                    name: model.name === undefined ? model.id : model.name,
                    reasoning: model.reasoning === undefined ? false : model.reasoning,
                  };
                })
              : connection.models,
          };
        }),
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
