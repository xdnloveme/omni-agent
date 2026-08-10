import { copyFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { containsSecretField } from "@omni-agent/models";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import { migrateLegacyConfig, type OmniConfigV1 } from "./config-migration";
import type { ConfigDiagnostic, OmniConfigV2 } from "./types";

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

export class ConfigService {
  readonly diagnostics: ConfigDiagnostic[] = [];

  constructor(
    private readonly cwd = process.cwd(),
    private readonly configDirectory = join(homedir(), ".omni-agent"),
  ) {}

  async load(): Promise<OmniConfigV2 | null> {
    this.diagnostics.length = 0;
    try {
      const parsed = await new AtomicJsonFile<unknown>(this.path).read();
      if (parsed === undefined) return null;
      if (isConfigV2(parsed)) {
        assertSecretFreeConfig(parsed);
        return parsed;
      }
      if (isConfigV1(parsed)) {
        const migrated: OmniConfigV2 = {
          version: 2,
          model: await migrateLegacyConfig(parsed, this.cwd),
        };
        await this.save(migrated);
        return migrated;
      }
      throw new InvalidConfigError("Configuration format is invalid");
    } catch (error) {
      this.diagnostics.push({
        code:
          error instanceof SyntaxError || error instanceof InvalidConfigError
            ? "invalid_config"
            : "migration_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async save(config: OmniConfigV2): Promise<void> {
    assertSecretFreeConfig(config);
    try {
      const current = JSON.parse(await readFile(this.path, "utf8")) as { version?: unknown };
      if (current.version !== 2) await copyFile(this.path, `${this.path}.v1.backup`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await new AtomicJsonFile<OmniConfigV2>(this.path).write(config);
  }

  get directory(): string {
    return this.configDirectory;
  }

  get path(): string {
    return join(this.directory, "config.json");
  }
}

class InvalidConfigError extends Error {}

function assertSecretFreeConfig(config: OmniConfigV2): void {
  if (containsSecretField(config)) {
    throw new InvalidConfigError("Secret values are not allowed in model configuration");
  }
}
