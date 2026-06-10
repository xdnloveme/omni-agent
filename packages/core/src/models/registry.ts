import { anthropicPresets } from "./providers/anthropic";
import { customPresets } from "./providers/custom";
import { kimiPresets } from "./providers/kimi";
import type { ModelPreset, ProviderId } from "./types";

export const MODEL_PRESETS: ModelPreset[] = [
  ...anthropicPresets,
  ...kimiPresets,
  ...customPresets,
];

export const PROVIDER_IDS: ProviderId[] = ["anthropic", "kimi", "kimi-cn", "kimi-code", "custom"];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.includes(value as ProviderId);
}

export function getModelPresetById(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id);
}

export function getDefaultPresetForProvider(provider: ProviderId | undefined): ModelPreset {
  return MODEL_PRESETS.find((preset) => preset.provider === (provider ?? "anthropic")) ?? anthropicPresets[0];
}
