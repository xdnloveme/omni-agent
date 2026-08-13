import type {
  ModelCacheDirective,
  ModelCacheFingerprint,
  ModelCacheLifecycle,
  ModelCallIdentity,
} from "@omni-agent/core";

export interface RuntimeModelCacheEntry {
  readonly identity: ModelCallIdentity;
  readonly directive: ModelCacheDirective;
  readonly fingerprint: ModelCacheFingerprint;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface ModelCacheComparison {
  readonly lifecycle: ModelCacheLifecycle;
  readonly commonPrefixMessageCount: number;
  readonly previousMessageCount: number;
  readonly currentMessageCount: number;
}

export class RuntimeModelCacheState {
  private readonly entries = new Map<string, RuntimeModelCacheEntry>();

  constructor(private readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Model cache state capacity must be a positive integer");
    }
  }

  get(scopeId: string, now = Date.now()): RuntimeModelCacheEntry | undefined {
    const entry = this.entries.get(scopeId);
    if (!entry) return undefined;
    this.entries.delete(scopeId);
    if (entry.expiresAt === undefined || now < entry.expiresAt) {
      this.entries.set(scopeId, entry);
    }
    return cloneEntry(entry);
  }

  set(scopeId: string, entry: RuntimeModelCacheEntry): void {
    this.entries.delete(scopeId);
    this.entries.set(scopeId, cloneEntry(entry));
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export function compareModelCacheState(
  previous: RuntimeModelCacheEntry | undefined,
  current: ModelCacheFingerprint,
  now: number,
): ModelCacheComparison {
  const previousCount = previous?.fingerprint.messageDigests.length ?? 0;
  const currentCount = current.messageDigests.length;
  if (!previous) return comparison("cold", 0, previousCount, currentCount);
  const common = commonPrefixLength(previous.fingerprint.messageDigests, current.messageDigests);
  if (previous.fingerprint.requestSemanticsDigest !== current.requestSemanticsDigest) {
    return comparison("incompatible", common, previousCount, currentCount);
  }
  if (previous.expiresAt !== undefined && now >= previous.expiresAt) {
    return comparison("expired", common, previousCount, currentCount);
  }
  if (previous.fingerprint.staticPrefixDigest !== current.staticPrefixDigest) {
    return comparison("rebased", common, previousCount, currentCount);
  }
  if (isPrefix(previous.fingerprint.messageDigests, current.messageDigests)) {
    return comparison("append_only", previousCount, previousCount, currentCount);
  }
  if (previousCount === currentCount && previousCount > 0 && common === previousCount - 1) {
    return comparison("tail_changed", common, previousCount, currentCount);
  }
  if (previousCount > 0 && currentCount > 0 && common === 0) {
    return comparison("rebased", common, previousCount, currentCount);
  }
  return comparison("prefix_rewritten", common, previousCount, currentCount);
}

export function resolveCacheExpiry(
  directive: ModelCacheDirective,
  capability: { readonly shortTtlMs?: number; readonly longTtlMs?: number },
  createdAt: number,
): number | undefined {
  const ttl =
    directive.retention === "short"
      ? capability.shortTtlMs
      : directive.retention === "long"
        ? capability.longTtlMs
        : undefined;
  return ttl === undefined ? undefined : createdAt + ttl;
}

function comparison(
  lifecycle: ModelCacheLifecycle,
  commonPrefixMessageCount: number,
  previousMessageCount: number,
  currentMessageCount: number,
): ModelCacheComparison {
  return {
    lifecycle,
    commonPrefixMessageCount,
    previousMessageCount,
    currentMessageCount,
  };
}

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  const maximum = Math.min(left.length, right.length);
  let index = 0;
  while (index < maximum && left[index] === right[index]) index++;
  return index;
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((entry, index) => value[index] === entry);
}

function cloneEntry(entry: RuntimeModelCacheEntry): RuntimeModelCacheEntry {
  return {
    identity: { ...entry.identity },
    directive: { ...entry.directive },
    fingerprint: {
      ...entry.fingerprint,
      messageDigests: [...entry.fingerprint.messageDigests],
    },
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}
