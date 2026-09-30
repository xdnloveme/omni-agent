import {
  DEFAULT_OUTPUT_LIMITS,
  type OutputStorageLimits,
} from "../persistence/session-artifact-store";
import { join, resolve } from "node:path";
import { isAgentId } from "@omni-agent/core";
import { containsSecretField, type ConfigurationScope } from "@omni-agent/models";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import type { ModelSelection } from "../models/model-service";
import type { ConfigDiagnostic, OmniConfig, ResolvedModelConfiguration } from "./types";
import {
  containsMcpSecrets,
  parseMcpConfiguration,
  type ResolvedMcpConfiguration,
} from "../mcp/config/types";

export interface ConfigServiceOptions {
  readonly cwd: string;
  readonly globalDirectory: string;
}

interface ConfigLayer {
  readonly present: boolean;
  readonly config: OmniConfig | null;
}

interface ConfigLayers {
  readonly global: ConfigLayer;
  readonly project: ConfigLayer;
}

const PROJECT_CONFIG_FILE = "omni.config.json";

export class ConfigService {
  readonly diagnostics: ConfigDiagnostic[] = [];
  private readonly globalPath: string;
  private readonly projectPath: string;

  constructor(options: ConfigServiceOptions) {
    const { cwd, globalDirectory } = options;
    this.globalPath = join(globalDirectory, "config.json");
    this.projectPath = resolve(cwd, PROJECT_CONFIG_FILE);
  }

  async resolveModel(agentId: string): Promise<ModelSelection | null> {
    return (await this.resolveModelConfiguration(agentId))?.selection ?? null;
  }

  async resolveModelConfiguration(agentId: string): Promise<ResolvedModelConfiguration | null> {
    assertAgentId(agentId);
    const layers = await this.loadLayers();
    if (layers.project.present && !layers.project.config) return null;
    const projectAgentModel = layers.project.config?.agents?.[agentId]?.model;
    if (projectAgentModel) {
      return { selection: projectAgentModel, scope: "project", kind: "agent" };
    }

    if (layers.global.present && !layers.global.config) return null;
    const globalAgentModel = layers.global.config?.agents?.[agentId]?.model;
    if (globalAgentModel) {
      return { selection: globalAgentModel, scope: "global", kind: "agent" };
    }
    if (layers.project.config) {
      return { selection: layers.project.config.model, scope: "project", kind: "shared" };
    }
    if (layers.global.config) {
      return { selection: layers.global.config.model, scope: "global", kind: "shared" };
    }
    return null;
  }

  async resolveSharedModel(): Promise<ModelSelection | null> {
    const layers = await this.loadLayers();
    if (layers.project.present && !layers.project.config) return null;
    if (layers.project.config) return layers.project.config.model;
    if (layers.global.present && !layers.global.config) return null;
    return layers.global.config?.model ?? null;
  }

  async resolveMcpServers(): Promise<ResolvedMcpConfiguration> {
    const layers = await this.loadLayers();
    for (const source of ["project", "global"] as const) {
      const layer = layers[source];
      if (layer.present && !layer.config)
        return {
          servers: [],
          diagnostics: [{ source, message: "Configuration file is invalid or unreadable" }],
        };
      if (layer.config?.mcp !== undefined) return parseMcpConfiguration(layer.config.mcp, source);
    }
    return { servers: [], diagnostics: [] };
  }

  async resolveOutputLimits(): Promise<OutputStorageLimits> {
    const layers = await this.loadLayers();
    for (const source of ["project", "global"] as const) {
      const layer = layers[source];
      if (layer.present && !layer.config) throw new Error(`Invalid ${source} output configuration`);
      if (layer.config?.outputRetention)
        return { ...DEFAULT_OUTPUT_LIMITS, ...layer.config.outputRetention };
    }
    return DEFAULT_OUTPUT_LIMITS;
  }

  async saveSharedModel(
    model: ModelSelection,
    options: { scope?: ConfigurationScope } = {},
  ): Promise<void> {
    const scope = options.scope ?? "global";
    const current = await this.loadWritableLayer(scope, model);
    await this.writeLayer(scope, { ...current, model });
  }

  async saveAgentModel(
    agentId: string,
    model: ModelSelection,
    options: { scope?: ConfigurationScope } = {},
  ): Promise<void> {
    assertAgentId(agentId);
    const scope = options.scope ?? "global";
    const shared = await this.resolveSharedModel();
    const current = await this.loadWritableLayer(scope, shared ?? model);
    await this.writeLayer(scope, {
      ...current,
      agents: {
        ...current.agents,
        [agentId]: { model },
      },
    });
  }

  async removeAgentModel(
    agentId: string,
    options: { scope?: ConfigurationScope } = {},
  ): Promise<void> {
    assertAgentId(agentId);
    const scope = options.scope ?? "global";
    const layer = await this.loadLayer(scope);
    if (!layer.present) return;
    if (!layer.config) throw new InvalidConfigError(`Cannot update invalid ${scope} config`);
    if (!layer.config.agents?.[agentId]) return;

    await this.writeLayer(scope, withoutAgentModel(layer.config, agentId));
  }

  private async loadLayers(): Promise<ConfigLayers> {
    this.diagnostics.length = 0;
    const [global, project] = await Promise.all([
      this.loadLayer("global"),
      this.loadLayer("project"),
    ]);
    return { global, project };
  }

  private async loadWritableLayer(
    scope: ConfigurationScope,
    fallbackModel: ModelSelection,
  ): Promise<OmniConfig> {
    const layer = await this.loadLayer(scope);
    if (layer.config) return layer.config;
    if (layer.present) throw new InvalidConfigError(`Cannot update invalid ${scope} config`);
    return { model: fallbackModel };
  }

  private async loadLayer(scope: ConfigurationScope): Promise<ConfigLayer> {
    try {
      const value = await new AtomicJsonFile<unknown>(this.path(scope)).read();
      if (value === undefined) return { present: false, config: null };
      const config = parseOmniConfig(value);
      if (!config) throw new InvalidConfigError("Configuration format is invalid");
      const { mcp: _mcp, ...modelConfig } = config;
      assertSecretFreeConfig(modelConfig);
      return { present: true, config };
    } catch (error) {
      this.diagnostics.push({
        code:
          error instanceof SyntaxError || error instanceof InvalidConfigError
            ? "invalid_config"
            : "read_failed",
        source: scope,
        message: error instanceof Error ? error.message : String(error),
      });
      return { present: true, config: null };
    }
  }

  private writeLayer(scope: ConfigurationScope, config: OmniConfig): Promise<void> {
    assertSecretFreeConfig(config);
    const persisted = scope === "global" ? { version: 3 as const, ...config } : config;
    return new AtomicJsonFile<unknown>(this.path(scope)).write(persisted);
  }

  private path(scope: ConfigurationScope): string {
    return scope === "global" ? this.globalPath : this.projectPath;
  }
}

class InvalidConfigError extends Error {}

function assertSecretFreeConfig(config: OmniConfig): void {
  const { mcp, ...modelConfig } = config;
  if (containsSecretField(modelConfig) || containsMcpSecrets(mcp)) {
    throw new InvalidConfigError("Secret values are not allowed in model configuration");
  }
}

function parseOmniConfig(value: unknown): OmniConfig | null {
  if (!isRecord(value)) return null;
  if (value.version !== undefined && value.version !== 3) return null;
  const { version: _legacyVersion, ...config } = value;
  if (!isModelSelection(config.model)) return null;
  if (config.agents !== undefined) {
    if (!isRecord(config.agents)) return null;
    if (
      !Object.entries(config.agents).every(
        ([agentId, entry]) =>
          isAgentId(agentId) && isRecord(entry) && isModelSelection(entry.model),
      )
    )
      return null;
  }
  if (config.outputRetention !== undefined) {
    if (!isRecord(config.outputRetention)) return null;
    if (
      !Object.entries(config.outputRetention).every(
        ([key, number]) =>
          ["previewBytes", "callBytes", "sessionBytes"].includes(key) &&
          typeof number === "number" &&
          Number.isSafeInteger(number) &&
          number > 0,
      )
    )
      return null;
  }
  return config as unknown as OmniConfig;
}

function withoutAgentModel(config: OmniConfig, agentId: string): OmniConfig {
  const agents = { ...config.agents };
  delete agents[agentId];
  const next: OmniConfig = { ...config };
  if (Object.keys(agents).length === 0) delete next.agents;
  else next.agents = agents;
  return next;
}

function assertAgentId(agentId: string): void {
  if (!isAgentId(agentId)) throw new InvalidConfigError(`Invalid agent id: ${agentId}`);
}

function isModelSelection(value: unknown): value is ModelSelection {
  if (!isRecord(value)) return false;
  return (
    ["vendorId", "connectionId", "modelId"].every(
      (key) => typeof value[key] === "string" && value[key].length > 0,
    ) &&
    (value.requestedOutputTokens === undefined ||
      (typeof value.requestedOutputTokens === "number" &&
        Number.isInteger(value.requestedOutputTokens) &&
        value.requestedOutputTokens > 0)) &&
    (value.settings === undefined || isRecord(value.settings))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
