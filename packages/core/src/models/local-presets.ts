import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Api } from "@mariozechner/pi-ai";

import { expandEnv, loadLocalEnv } from "./local-env";
import type { ModelPreset, ProviderId } from "./types";

const defaultLocalPresetsPath = ".omni-agent.local/models.json";

interface LocalModelPresetFile {
  presets?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequiredString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) return null;
  const expanded = expandEnv(field);
  return expanded && expanded.trim().length > 0 ? expanded : null;
}

function getRequiredPositiveNumber(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) && field > 0 ? field : null;
}

function getOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) return undefined;
  const expanded = expandEnv(field);
  return expanded && expanded.trim().length > 0 ? expanded : undefined;
}

function parsePreset(value: unknown): ModelPreset | null {
  if (!isRecord(value)) return null;

  const id = getRequiredString(value, "id");
  const name = getRequiredString(value, "name");
  const description = getRequiredString(value, "description");
  const provider = getRequiredString(value, "provider");
  const api = getRequiredString(value, "api");
  const endpoint = getRequiredString(value, "endpoint");
  const model = getRequiredString(value, "model");
  const maxTokens = getRequiredPositiveNumber(value, "maxTokens");
  const contextWindow = getRequiredPositiveNumber(value, "contextWindow");

  if (!id || !name || !description || !provider || !api || !endpoint || !model || !maxTokens || !contextWindow) {
    return null;
  }

  return {
    id,
    name,
    description,
    provider: provider as ProviderId,
    api: api as Api,
    endpoint,
    model,
    maxTokens,
    contextWindow,
    keychainAccount: getOptionalString(value, "keychainAccount"),
    apiKeyEnvVar: getOptionalString(value, "apiKeyEnvVar"),
  };
}

function parseLocalPresetFile(raw: string): ModelPreset[] {
  const parsed: unknown = JSON.parse(raw);
  let presets: unknown[] = [];
  if (Array.isArray(parsed)) {
    presets = parsed;
  } else if (isRecord(parsed)) {
    const candidate = (parsed as LocalModelPresetFile).presets;
    if (Array.isArray(candidate)) {
      presets = candidate;
    }
  }

  return presets.flatMap((preset) => {
    const parsedPreset = parsePreset(preset);
    return parsedPreset ? [parsedPreset] : [];
  });
}

function getLocalPresetPaths(): string[] {
  loadLocalEnv();

  const paths = [
    process.env.OMNI_MODEL_PRESETS_FILE,
    resolve(process.cwd(), defaultLocalPresetsPath),
  ].filter((path): path is string => Boolean(path));

  return Array.from(new Set(paths));
}

export function loadLocalModelPresets(): ModelPreset[] {
  return getLocalPresetPaths().flatMap((path) => {
    if (!existsSync(path)) return [];

    try {
      return parseLocalPresetFile(readFileSync(path, "utf-8"));
    } catch {
      return [];
    }
  });
}
