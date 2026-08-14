import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isAgentId } from "@omni-agent/core";
import { containsSecretField, type ConfigurationScope } from "@omni-agent/models";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import type { ModelSelection } from "../models/model-service";
import type { ConfigDiagnostic, OmniConfig, ResolvedModelConfiguration } from "./types";

export interface ConfigServiceOptions {
  readonly cwd?: string;
  readonly globalDirectory?: string;
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

  constructor(options: ConfigServiceOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const globalDirectory = options.globalDirectory ?? join(homedir(), ".omni-agent");
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

  async saveSharedModel(
    model: ModelSelection,
    options: { scope?: ConfigurationScope } = {},
  ): Promise<void> {
    const scope = options.scope ?? "project";
    const current = await this.loadWritableLayer(scope, model);
    await this.writeLayer(scope, { ...current, model });
  }

  async saveAgentModel(
    agentId: string,
    model: ModelSelection,
    options: { scope?: ConfigurationScope } = {},
  ): Promise<void> {
    assertAgentId(agentId);
    const scope = options.scope ?? "project";
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
    const scope = options.scope ?? "project";
    const layer = await this.loadLayer(scope);
    if (!layer.present) return;
    if (!layer.config) throw new InvalidConfigError(`Cannot update invalid ${scope} config`);
    if (!layer.config.agents?.[agentId]) return;

    await this.writeLayer(scope, withoutAgentModel(layer.config, agentId));
  }

  async clearAgentModelOverrides(agentId: string): Promise<void> {
    assertAgentId(agentId);
    const layers = await this.loadLayers();
    if (layers.project.present && !layers.project.config) {
      throw new InvalidConfigError("Cannot update invalid project config");
    }
    if (layers.global.present && !layers.global.config) {
      throw new InvalidConfigError("Cannot update invalid global config");
    }

    const updates = (["global", "project"] as const).flatMap((scope) => {
      const config = layers[scope].config;
      if (!config?.agents?.[agentId]) return [];
      return [{ scope, previous: config, next: withoutAgentModel(config, agentId) }];
    });
    const applied: typeof updates = [];
    try {
      for (const update of updates) {
        await this.writeLayer(update.scope, update.next);
        applied.push(update);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const update of [...applied].reverse()) {
        try {
          await this.writeLayer(update.scope, update.previous);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Failed to clear model overrides for Agent: ${agentId}`,
        );
      }
      throw error;
    }
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
    return { version: 3, model: fallbackModel };
  }

  private async loadLayer(scope: ConfigurationScope): Promise<ConfigLayer> {
    try {
      const value = await new AtomicJsonFile<unknown>(this.path(scope)).read();
      if (value === undefined) return { present: false, config: null };
      if (!isOmniConfig(value)) throw new InvalidConfigError("Configuration format is invalid");
      assertSecretFreeConfig(value);
      return { present: true, config: value };
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
    return new AtomicJsonFile<OmniConfig>(this.path(scope)).write(config);
  }

  private path(scope: ConfigurationScope): string {
    return scope === "global" ? this.globalPath : this.projectPath;
  }
}

class InvalidConfigError extends Error {}

function assertSecretFreeConfig(config: OmniConfig): void {
  if (containsSecretField(config)) {
    throw new InvalidConfigError("Secret values are not allowed in model configuration");
  }
}

function isOmniConfig(value: unknown): value is OmniConfig {
  if (!isRecord(value) || value.version !== 3 || !isModelSelection(value.model)) return false;
  if (value.agents === undefined) return true;
  if (!isRecord(value.agents)) return false;
  return Object.entries(value.agents).every(
    ([agentId, entry]) => isAgentId(agentId) && isRecord(entry) && isModelSelection(entry.model),
  );
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
