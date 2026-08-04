import { anthropicPresets } from "./providers/anthropic";
import { customPresets } from "./providers/custom";
import { deepseekPresets } from "./providers/deepseek";
import { googlePresets } from "./providers/google";
import { kimiPresets } from "./providers/kimi";
import { mistralPresets } from "./providers/mistral";
import { openaiPresets } from "./providers/openai";
import { openrouterPresets } from "./providers/openrouter";
import { qwenPresets } from "./providers/qwen";
import { loadLocalModelPresets } from "./local-presets";
import type { BuiltinProviderId, ModelPreset, ProviderId } from "./types";

const builtinModelPresets: ModelPreset[] = [
  ...openaiPresets,
  ...anthropicPresets,
  ...googlePresets,
  ...mistralPresets,
  ...deepseekPresets,
  ...qwenPresets,
  ...kimiPresets,
  ...openrouterPresets,
  ...customPresets,
];

const localModelPresets = loadLocalModelPresets();

export const MODEL_PRESETS: ModelPreset[] = [
  ...builtinModelPresets,
  ...localModelPresets,
];

export const BUILTIN_PROVIDER_IDS: BuiltinProviderId[] = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "deepseek",
  "qwen",
  "openrouter",
  "kimi",
  "kimi-cn",
  "kimi-code",
  "custom",
];

export const PROVIDER_IDS: ProviderId[] = Array.from(
  new Set<ProviderId>([
    ...BUILTIN_PROVIDER_IDS,
    ...localModelPresets.map((preset) => preset.provider),
  ]),
);

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.includes(value as ProviderId);
}

export function getModelPresetById(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id);
}

export function getDefaultPresetForProvider(provider: ProviderId | undefined): ModelPreset {
  return MODEL_PRESETS.find((preset) => preset.provider === (provider ?? "anthropic")) ?? anthropicPresets[0];
}
