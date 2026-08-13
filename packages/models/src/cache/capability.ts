import type { ModelCacheCapability, ModelCacheMode, ModelCacheRetention } from "@omni-agent/core";

const RETENTIONS = ["none", "short", "long"] as const;
const MODES = ["none", "automatic_prefix", "explicit_breakpoint"] as const;

const NONE: ModelCacheCapability = {
  mode: "none",
  retentions: ["none"],
  supportsStableScopeKey: false,
};

export interface ModelCacheCapabilitySource {
  readonly api: string;
  readonly baseUrl: string;
  readonly compat?: unknown;
  readonly explicit?: ModelCacheCapability;
}

export function resolveModelCacheCapability(
  source: ModelCacheCapabilitySource,
): ModelCacheCapability {
  if (source.explicit) return normalizeModelCacheCapability(source.explicit);

  // Capability follows the concrete API and compat flags; Vendor names are not protocol facts.
  if (source.api === "anthropic-messages") {
    const supportsLong = compatBoolean(source.compat, "supportsLongCacheRetention") !== false;
    return normalizeModelCacheCapability({
      mode: "explicit_breakpoint",
      retentions: supportsLong ? ["none", "short", "long"] : ["none", "short"],
      supportsStableScopeKey: compatBoolean(source.compat, "sendSessionAffinityHeaders") === true,
      shortTtlMs: 5 * 60 * 1000,
      ...(supportsLong ? { longTtlMs: 60 * 60 * 1000 } : {}),
    });
  }
  if (source.api === "openai-responses") {
    const supportsLong = compatBoolean(source.compat, "supportsLongCacheRetention") !== false;
    return normalizeModelCacheCapability({
      mode: "automatic_prefix",
      retentions: supportsLong ? ["none", "short", "long"] : ["none", "short"],
      supportsStableScopeKey: true,
      ...(supportsLong ? { longTtlMs: 24 * 60 * 60 * 1000 } : {}),
    });
  }
  if (source.api === "openai-completions") {
    const supportsLong = compatBoolean(source.compat, "supportsLongCacheRetention") !== false;
    const nativeOpenAi = source.baseUrl.includes("api.openai.com");
    const sendsAffinity = compatBoolean(source.compat, "sendSessionAffinityHeaders") === true;
    return normalizeModelCacheCapability({
      mode: "automatic_prefix",
      retentions: supportsLong ? ["none", "short", "long"] : ["none", "short"],
      // Stable scope exists only when the transport consumes sessionId: native OpenAI,
      // affinity headers, or the long-retention path that emits a stable prefix key.
      supportsStableScopeKey: nativeOpenAi || sendsAffinity || supportsLong,
      ...(supportsLong ? { longTtlMs: 24 * 60 * 60 * 1000 } : {}),
    });
  }
  if (source.api === "google-generative-ai") {
    return normalizeModelCacheCapability({
      mode: "automatic_prefix",
      retentions: ["none", "short"],
      supportsStableScopeKey: false,
    });
  }
  if (source.api === "mistral-conversations") {
    return normalizeModelCacheCapability({
      mode: "automatic_prefix",
      retentions: ["none", "short"],
      supportsStableScopeKey: true,
    });
  }
  return normalizeModelCacheCapability(NONE);
}

export function normalizeModelCacheCapability(
  capability: ModelCacheCapability,
): ModelCacheCapability {
  const mode = capability.mode as ModelCacheMode;
  if (!MODES.includes(mode)) {
    throw new Error(`Invalid model cache mode: ${String(capability.mode)}`);
  }
  const retentions = capability.retentions as readonly ModelCacheRetention[];
  if (
    !Array.isArray(retentions) ||
    retentions.length === 0 ||
    !retentions.includes("none") ||
    retentions.some((retention) => !RETENTIONS.includes(retention)) ||
    new Set(retentions).size !== retentions.length
  ) {
    throw new Error("Invalid model cache retentions");
  }
  if (typeof capability.supportsStableScopeKey !== "boolean") {
    throw new Error("Invalid model cache stable-scope capability");
  }
  if (mode === "none") {
    if (
      retentions.length !== 1 ||
      retentions[0] !== "none" ||
      capability.supportsStableScopeKey ||
      capability.shortTtlMs !== undefined ||
      capability.longTtlMs !== undefined
    ) {
      throw new Error("Disabled model cache capability cannot declare retention, scope, or TTL");
    }
  } else if (!retentions.some((retention) => retention !== "none")) {
    throw new Error("Enabled model cache capability requires an active retention");
  }
  validateTtl("short", capability.shortTtlMs, retentions);
  validateTtl("long", capability.longTtlMs, retentions);
  return { ...capability, retentions: [...retentions] };
}

function validateTtl(
  retention: "short" | "long",
  ttl: number | undefined,
  supported: readonly ModelCacheRetention[],
): void {
  if (ttl === undefined) return;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error(`Invalid ${retention} model cache TTL`);
  if (!supported.includes(retention)) {
    throw new Error(`Model cache ${retention} TTL requires ${retention} retention support`);
  }
}

function compatBoolean(compat: unknown, key: string): boolean | undefined {
  if (!compat || typeof compat !== "object") return undefined;
  const value = (compat as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}
