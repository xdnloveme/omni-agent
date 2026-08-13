import type { ModelCacheCapability } from "@omni-agent/core";

const NONE: ModelCacheCapability = {
  mode: "none",
  retentions: ["none"],
  supportsStableScopeKey: false,
};

export function resolveModelCacheCapability(
  api: string,
  explicit?: ModelCacheCapability,
): ModelCacheCapability {
  if (explicit) return cloneCapability(explicit);
  if (api === "anthropic-messages") {
    return {
      mode: "explicit_breakpoint",
      retentions: ["none", "short", "long"],
      supportsStableScopeKey: true,
      shortTtlMs: 5 * 60 * 1000,
      longTtlMs: 60 * 60 * 1000,
    };
  }
  if (api === "openai-completions" || api === "openai-responses") {
    return {
      mode: "automatic_prefix",
      retentions: ["none", "short", "long"],
      supportsStableScopeKey: true,
      longTtlMs: 24 * 60 * 60 * 1000,
    };
  }
  if (api === "google-generative-ai") {
    return {
      mode: "automatic_prefix",
      retentions: ["none", "short"],
      supportsStableScopeKey: false,
    };
  }
  if (api === "mistral-conversations") {
    return {
      mode: "automatic_prefix",
      retentions: ["none", "short"],
      supportsStableScopeKey: true,
    };
  }
  return cloneCapability(NONE);
}

function cloneCapability(capability: ModelCacheCapability): ModelCacheCapability {
  return { ...capability, retentions: [...capability.retentions] };
}
