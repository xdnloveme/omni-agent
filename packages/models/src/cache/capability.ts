import type { ModelCacheCapability, ModelCacheMode, ModelCacheRetention } from "@omni-agent/core";

const RETENTIONS = ["none", "short", "long"] as const;
const MODES = ["none", "automatic_prefix", "explicit_breakpoint"] as const;

const NONE: ModelCacheCapability = {
  mode: "none",
  retentions: ["none"],
  stableScopeRetentions: [],
};

export interface ModelCacheCapabilitySource {
  readonly api: string;
  readonly compat?: unknown;
  readonly explicit?: ModelCacheCapability;
}

export function resolveModelCacheCapability(
  source: ModelCacheCapabilitySource,
): ModelCacheCapability {
  if (source.explicit) return normalizeModelCacheCapability(source.explicit);

  // Capability follows the concrete API and compat flags; Vendor names are not protocol facts.
  if (source.api === "anthropic-messages") {
    const supportsLong = resolveLongRetentionSupport(source);
    const retentions: ModelCacheRetention[] = supportsLong
      ? ["none", "short", "long"]
      : ["none", "short"];
    const sendsAffinity = readCompatBoolean(source.compat, "sendSessionAffinityHeaders") === true;
    return normalizeModelCacheCapability({
      mode: "explicit_breakpoint",
      retentions,
      stableScopeRetentions: sendsAffinity ? activeRetentions(retentions) : [],
      shortTtlMs: 5 * 60 * 1000,
      ...(supportsLong ? { longTtlMs: 60 * 60 * 1000 } : {}),
    });
  }
  if (source.api === "openai-responses") {
    const supportsLong = resolveLongRetentionSupport(source);
    const retentions: ModelCacheRetention[] = supportsLong
      ? ["none", "short", "long"]
      : ["none", "short"];
    return normalizeModelCacheCapability({
      mode: "automatic_prefix",
      retentions,
      stableScopeRetentions: activeRetentions(retentions),
      ...(supportsLong ? { longTtlMs: 24 * 60 * 60 * 1000 } : {}),
    });
  }
  if (source.api === "openai-completions") {
    const supportsLong = resolveLongRetentionSupport(source);
    const sendsAffinity = readCompatBoolean(source.compat, "sendSessionAffinityHeaders") === true;
    const usesAnthropicCacheControl =
      compatString(source.compat, "cacheControlFormat") === "anthropic";
    const retentions: ModelCacheRetention[] = supportsLong
      ? ["none", "short", "long"]
      : ["none", "short"];
    return normalizeModelCacheCapability({
      mode: "automatic_prefix",
      retentions,
      // pi-ai consumes sessionId per retention: native OpenAI emits a stable request key for
      // every active retention, compatible APIs emit it for long retention, and affinity
      // headers consume it for every active retention when explicitly enabled.
      stableScopeRetentions: activeRetentions(retentions).filter(
        (retention) => sendsAffinity || retention === "long",
      ),
      ...(supportsLong ? { longTtlMs: (usesAnthropicCacheControl ? 1 : 24) * 60 * 60 * 1000 } : {}),
    });
  }
  if (source.api === "google-generative-ai") {
    return normalizeModelCacheCapability({
      mode: "automatic_prefix",
      retentions: ["none", "short"],
      stableScopeRetentions: [],
    });
  }
  if (source.api === "mistral-conversations") {
    return normalizeModelCacheCapability({
      mode: "automatic_prefix",
      retentions: ["none", "short"],
      stableScopeRetentions: ["short"],
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
  const stableScopeRetentions = capability.stableScopeRetentions as readonly ModelCacheRetention[];
  if (
    !Array.isArray(stableScopeRetentions) ||
    stableScopeRetentions.some(
      (retention) =>
        retention === "none" || !RETENTIONS.includes(retention) || !retentions.includes(retention),
    ) ||
    new Set(stableScopeRetentions).size !== stableScopeRetentions.length
  ) {
    throw new Error("Invalid model cache stable-scope capability");
  }
  if (mode === "none") {
    if (
      retentions.length !== 1 ||
      retentions[0] !== "none" ||
      stableScopeRetentions.length > 0 ||
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
  return {
    ...capability,
    retentions: [...retentions],
    stableScopeRetentions: [...stableScopeRetentions],
  };
}

function activeRetentions(
  retentions: readonly ModelCacheRetention[],
): Array<Exclude<ModelCacheRetention, "none">> {
  return retentions.filter(
    (retention): retention is Exclude<ModelCacheRetention, "none"> => retention !== "none",
  );
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

export function readCompatBoolean(compat: unknown, key: string): boolean | undefined {
  if (!compat || typeof compat !== "object") return undefined;
  const value = (compat as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function compatString(compat: unknown, key: string): string | undefined {
  if (!compat || typeof compat !== "object") return undefined;
  const value = (compat as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function resolveLongRetentionSupport(source: ModelCacheCapabilitySource): boolean {
  return readCompatBoolean(source.compat, "supportsLongCacheRetention") === true;
}
