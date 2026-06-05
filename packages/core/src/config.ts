import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OmniConfig {
  provider: "anthropic" | "kimi" | "custom";
  endpoint: string;
  model: string;
  maxTokens?: number;
  contextWindow?: number;
}

const CONFIG_DIR_NAME = ".omni-agent";
const CONFIG_FILE_NAME = "config.json";

export function getConfigDir(): string {
  const dir = join(homedir(), CONFIG_DIR_NAME);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE_NAME);
}

function isConfigValid(value: unknown): value is OmniConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!["anthropic", "kimi", "custom"].includes(obj.provider as string)) return false;
  if (typeof obj.endpoint !== "string" || obj.endpoint.length === 0) return false;
  if (typeof obj.model !== "string" || obj.model.length === 0) return false;
  if (obj.maxTokens !== undefined && (typeof obj.maxTokens !== "number" || obj.maxTokens <= 0)) return false;
  if (obj.contextWindow !== undefined && (typeof obj.contextWindow !== "number" || obj.contextWindow <= 0)) return false;
  return true;
}

export function loadConfig(): OmniConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isConfigValid(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: OmniConfig): void {
  const configPath = getConfigPath();
  getConfigDir(); // ensure dir exists
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
