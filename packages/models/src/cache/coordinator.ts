import type {
  ModelCacheCapability,
  ModelCacheIntent,
  ModelCacheLeaseAdvice,
  ModelCacheLeaseAdvisorPort,
  ModelCachePolicyPort,
  ModelCacheRetention,
  ModelCallIdentity,
  ModelRequest,
  RuntimeModelSelection,
} from "@omni-agent/core";
import type { ModelCacheFingerprint } from "./contracts";
import { ModelCacheFingerprinter } from "./fingerprint";
import { compareModelCacheState, resolveCacheExpiry, RuntimeModelCacheState } from "./state";

type ModelCacheCapabilityResolver = (selection: RuntimeModelSelection) => ModelCacheCapability;

export class ModelCacheCoordinator implements ModelCacheLeaseAdvisorPort {
  constructor(
    private readonly policy: ModelCachePolicyPort,
    private readonly capabilities: ModelCacheCapabilityResolver,
    private readonly fingerprinter = new ModelCacheFingerprinter(),
    private readonly state = new RuntimeModelCacheState(),
    private readonly now: () => number = Date.now,
  ) {}

  prepare(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    identity: ModelCallIdentity,
    intent: ModelCacheIntent,
  ) {
    const capability = this.capabilities(selection);
    const decision = this.policy.resolve({ identity, intent, capability, selection });
    const fingerprint = this.fingerprinter.fingerprint(selection, request);
    const now = this.now();
    const previous =
      decision.directive.retention === "none"
        ? undefined
        : this.state.get(decision.directive.scopeId, now);
    return {
      capability,
      decision,
      fingerprint,
      comparison: compareModelCacheState(previous, fingerprint, now),
    };
  }

  recordSuccess(input: {
    readonly scopeId: string;
    readonly retention: ModelCacheRetention;
    readonly capability: ModelCacheCapability;
    readonly fingerprint: ModelCacheFingerprint;
  }): void {
    if (input.retention === "none") return;
    const createdAt = this.now();
    this.state.set(input.scopeId, {
      fingerprint: input.fingerprint,
      retention: input.retention,
      expiresAt: resolveCacheExpiry(
        { scopeId: input.scopeId, retention: input.retention },
        input.capability,
        createdAt,
      ),
    });
  }

  inspect(
    selection: RuntimeModelSelection,
    identity: ModelCallIdentity,
    intent: ModelCacheIntent,
  ): ModelCacheLeaseAdvice {
    const capability = this.capabilities(selection);
    const decision = this.policy.resolve({ identity, intent, capability, selection });
    const { scopeId, retention } = decision.directive;
    if (retention === "none") return { status: "disabled", scopeId, retention };
    const entry = this.state.peek(scopeId);
    if (!entry) return { status: "cold", scopeId, retention };
    if (entry.expiresAt === undefined) {
      return { status: "unknown_expiry", scopeId, retention: entry.retention };
    }
    return this.now() >= entry.expiresAt
      ? { status: "expired", scopeId, retention: entry.retention, expiresAt: entry.expiresAt }
      : { status: "active", scopeId, retention: entry.retention, expiresAt: entry.expiresAt };
  }

  clear(): void {
    this.state.clear();
  }
}
