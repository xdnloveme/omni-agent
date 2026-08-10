import { copyFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { containsSecretField, type ConfigurationScope } from "@omni-agent/models";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import { migrateLegacyConfig, type OmniConfigV1 } from "./config-migration";
import type { ConfigDiagnostic, OmniConfigV2 } from "./types";

export interface ConfigServiceOptions {
  readonly cwd?: string;
  readonly globalDirectory?: string;
}

interface LoadedConfig {
  readonly present: boolean;
  readonly config: OmniConfigV2 | null;
}

export class ConfigService {
  readonly diagnostics: ConfigDiagnostic[] = [];
  private readonly cwd: string;
  private readonly globalDirectory: string;
  private readonly globalPath: string;
  private readonly projectPath: string;

  constructor(options: ConfigServiceOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.globalDirectory = options.globalDirectory ?? join(homedir(), ".omni-agent");
    this.globalPath = join(this.globalDirectory, "config.json");
    this.projectPath = resolve(this.cwd, ".omni-agent/config.json");
  }

  async load(): Promise<OmniConfigV2 | null> {
    this.diagnostics.length = 0;
    const global = await this.loadLayer("global");
    const project = await this.loadLayer("project");
    if (project.present) return project.config;
    return global.config;
  }

  save(config: OmniConfigV2, options: { scope?: ConfigurationScope } = {}): Promise<void> {
    assertSecretFreeConfig(config);
    return this.saveLayer(config, options.scope ?? "project");
  }

  private path(scope: ConfigurationScope): string {
    return scope === "global" ? this.globalPath : this.projectPath;
  }

  private async loadLayer(scope: ConfigurationScope): Promise<LoadedConfig> {
    const path = this.path(scope);
    try {
      const parsed = await new AtomicJsonFile<unknown>(path).read();
      if (parsed === undefined) return { present: false, config: null };
      if (isConfigV2(parsed)) {
        assertSecretFreeConfig(parsed);
        return { present: true, config: parsed };
      }
      if (isConfigV1(parsed)) {
        const migrated: OmniConfigV2 = {
          version: 2,
          model: await migrateLegacyConfig(parsed, {
            cwd: this.cwd,
            globalDirectory: this.globalDirectory,
            scope,
          }),
        };
        await this.saveLayer(migrated, scope);
        return { present: true, config: migrated };
      }
      throw new InvalidConfigError("Configuration format is invalid");
    } catch (error) {
      this.diagnostics.push({
        code:
          error instanceof SyntaxError || error instanceof InvalidConfigError
            ? "invalid_config"
            : "migration_failed",
        source: scope,
        message: error instanceof Error ? error.message : String(error),
      });
      return { present: true, config: null };
    }
  }

  private async saveLayer(config: OmniConfigV2, scope: ConfigurationScope): Promise<void> {
    const path = this.path(scope);
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
      if (current.version !== 2) await copyFile(path, `${path}.v1.backup`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await new AtomicJsonFile<OmniConfigV2>(path).write(config);
  }
}

class InvalidConfigError extends Error {}

function assertSecretFreeConfig(config: OmniConfigV2): void {
  if (containsSecretField(config)) {
    throw new InvalidConfigError("Secret values are not allowed in model configuration");
  }
}

function isConfigV2(value: unknown): value is OmniConfigV2 {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 2 || typeof obj.model !== "object" || obj.model === null) return false;
  const model = obj.model as Record<string, unknown>;
  return (
    ["vendorId", "connectionId", "modelId"].every(
      (key) => typeof model[key] === "string" && model[key] !== "",
    ) &&
    (model.settings === undefined ||
      (typeof model.settings === "object" &&
        model.settings !== null &&
        !Array.isArray(model.settings)))
  );
}

function isConfigV1(value: unknown): value is OmniConfigV1 {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.provider === "string" &&
    typeof config.endpoint === "string" &&
    typeof config.model === "string"
  );
}
