import type { ModelCacheDirective, ModelCacheLifecycle } from "@omni-agent/core";
import type { ModelCacheFingerprint } from "./contracts";

export interface RuntimeModelCacheEntry {
  readonly fingerprint: ModelCacheFingerprint;
  readonly retention: ModelCacheDirective["retention"];
  readonly expiresAt?: number;
}

interface ModelCacheLeaseSnapshot {
  readonly version: 1;
  readonly scopeId: string;
  readonly fingerprint: ModelCacheFingerprint;
  readonly retention: Exclude<ModelCacheDirective["retention"], "none">;
  readonly expiresAt?: number;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

  peek(scopeId: string): RuntimeModelCacheEntry | undefined {
    const entry = this.entries.get(scopeId);
    return entry ? cloneEntry(entry) : undefined;
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

  hydrate(snapshot: unknown, now = Date.now()): string | undefined {
    assertModelCacheLeaseSnapshot(snapshot);
    if (snapshot.expiresAt !== undefined && now >= snapshot.expiresAt) {
      this.entries.delete(snapshot.scopeId);
      return undefined;
    }
    this.set(snapshot.scopeId, snapshot);
    return snapshot.scopeId;
  }

  snapshot(scopeId: string): unknown | undefined {
    const entry = this.peek(scopeId);
    if (!entry || entry.retention === "none") return undefined;
    return {
      version: 1,
      scopeId,
      fingerprint: entry.fingerprint,
      retention: entry.retention,
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
    } satisfies ModelCacheLeaseSnapshot;
  }

  remove(scopeId: string): void {
    this.entries.delete(scopeId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export function assertModelCacheLeaseSnapshot(
  value: unknown,
): asserts value is ModelCacheLeaseSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "scopeId", "fingerprint", "retention", "expiresAt"])
  ) {
    throw new Error("Invalid model cache lease snapshot");
  }
  const candidate = value as Partial<ModelCacheLeaseSnapshot>;
  const fingerprint = candidate.fingerprint;
  if (
    candidate.version !== 1 ||
    !isDigest(candidate.scopeId) ||
    (candidate.retention !== "short" && candidate.retention !== "long") ||
    (candidate.expiresAt !== undefined &&
      (!Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt <= 0)) ||
    !isRecord(fingerprint) ||
    !hasOnlyKeys(fingerprint, ["staticPrefixDigest", "messageDigests", "requestSemanticsDigest"]) ||
    !isDigest(fingerprint.staticPrefixDigest) ||
    !isDigest(fingerprint.requestSemanticsDigest) ||
    !Array.isArray(fingerprint.messageDigests) ||
    !fingerprint.messageDigests.every(isDigest)
  ) {
    throw new Error("Invalid model cache lease snapshot");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function compareModelCacheState(
  previous: RuntimeModelCacheEntry | undefined,
  current: ModelCacheFingerprint,
  now: number,
): ModelCacheComparison {
  // Ordering is part of the lifecycle contract: semantic incompatibility and known expiry
  // take precedence over structural prefix comparisons.
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
  // Unknown Provider TTL stays unknown; the runtime never guesses expiration.
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
    fingerprint: {
      ...entry.fingerprint,
      messageDigests: [...entry.fingerprint.messageDigests],
    },
    retention: entry.retention,
    expiresAt: entry.expiresAt,
  };
}
