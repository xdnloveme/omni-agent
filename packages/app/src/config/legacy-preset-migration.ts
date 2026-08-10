import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LocalProviderRepository,
  type CompatibleProtocol,
  type LocalProviderDefinition,
} from "@omni-agent/models";
import type { ModelSelection } from "../models/model-service";
import { normalizeEndpoint } from "./endpoint";

interface LegacySelection {
  provider: string;
  endpoint: string;
  model: string;
}

interface LegacyModelPreset {
  id: string;
  name: string;
  provider: string;
  api: CompatibleProtocol;
  endpoint: string;
  model: string;
  maxTokens: number;
  contextWindow: number;
  apiKeyEnvVar?: string;
  keychainAccount?: string;
}

const SUPPORTED_PROTOCOLS = new Set<CompatibleProtocol>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
]);

export async function migrateLegacyLocalPreset(
  selection: LegacySelection,
  cwd: string,
  reservedVendorIds: ReadonlySet<string>,
  repository = new LocalProviderRepository(cwd),
): Promise<ModelSelection | null> {
  const presets = readLegacyPresets(cwd);
  const endpoint = normalizeEndpoint(selection.endpoint);
  const selected = presets.find(
    (preset) =>
      preset.provider === selection.provider &&
      preset.model === selection.model &&
      normalizeEndpoint(preset.endpoint) === endpoint,
  );
  if (!selected) return null;
  const related = presets.filter(
    (preset) =>
      preset.provider === selected.provider &&
      preset.api === selected.api &&
      normalizeEndpoint(preset.endpoint) === endpoint,
  );
  const safeId =
    selected.provider
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "local";
  const suffix = createHash("sha256")
    .update(`${selected.provider}\0${selected.endpoint}\0${selected.api}`)
    .digest("hex")
    .slice(0, 8);
  const id = reservedVendorIds.has(selected.provider) ? `local-${safeId}-${suffix}` : safeId;
  const envVars = [
    ...new Set(related.flatMap((preset) => (preset.apiKeyEnvVar ? [preset.apiKeyEnvVar] : []))),
  ];
  const credentialAliases = [
    ...new Set(
      related.flatMap((preset) =>
        [preset.provider, preset.keychainAccount].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ),
  ];
  await repository.upsert({
    id,
    displayName: selected.provider,
    baseUrl: selected.endpoint,
    envVars: envVars.length > 0 ? envVars : [`${safeId.replace(/-/g, "_").toUpperCase()}_API_KEY`],
    protocol: selected.api,
    credentialAliases,
    models: related.map((preset) => ({
      id: preset.model,
      name: preset.name,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
    })),
  });
  return { vendorId: id, connectionId: "default", modelId: selected.model };
}

function readLegacyPresets(cwd: string): LegacyModelPreset[] {
  const paths = [
    ...new Set(
      [
        process.env.OMNI_MODEL_PRESETS_FILE && resolve(cwd, process.env.OMNI_MODEL_PRESETS_FILE),
        resolve(cwd, ".omni-agent.local/models.json"),
      ].filter((path): path is string => Boolean(path)),
    ),
  ];
  const presets: LegacyModelPreset[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { presets?: unknown }).presets)
        ? (parsed as { presets: unknown[] }).presets
        : [];
    for (const value of values) {
      if (typeof value !== "object" || value === null) continue;
      const preset = value as Record<string, unknown>;
      if (
        typeof preset.id !== "string" ||
        typeof preset.name !== "string" ||
        typeof preset.provider !== "string" ||
        typeof preset.api !== "string" ||
        !SUPPORTED_PROTOCOLS.has(preset.api as CompatibleProtocol) ||
        typeof preset.endpoint !== "string" ||
        typeof preset.model !== "string" ||
        typeof preset.maxTokens !== "number" ||
        typeof preset.contextWindow !== "number"
      )
        continue;
      presets.push(preset as unknown as LegacyModelPreset);
    }
  }
  return presets;
}
