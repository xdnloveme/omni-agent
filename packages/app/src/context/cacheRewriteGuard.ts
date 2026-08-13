import { throwIfAborted } from "@omni-agent/core";
import type {
  ContextRewriteGuardDecision,
  ContextRewriteGuardInput,
  ContextRewriteGuardPort,
  DeepReadonly,
  ModelCacheIntent,
  ModelCacheLeaseAdvisorPort,
  RuntimeModelSelection,
} from "@omni-agent/core";

export class CacheBackedContextRewriteGuard implements ContextRewriteGuardPort {
  constructor(
    private readonly advisor: ModelCacheLeaseAdvisorPort,
    private readonly selection: () => RuntimeModelSelection,
    private readonly intent: ModelCacheIntent = { retention: "default" },
  ) {}

  assess(input: DeepReadonly<ContextRewriteGuardInput>): ContextRewriteGuardDecision {
    throwIfAborted(input.signal);
    const advice = this.advisor.inspect(
      this.selection(),
      {
        agentId: input.agentId,
        sessionId: input.sessionId,
        modelCallId: input.modelCallId,
        purpose: "primary",
      },
      this.intent,
    );
    if (advice.status === "active") {
      return {
        action: "defer",
        reason: "model_cache_lease_active",
        reconsiderAt: advice.expiresAt,
      };
    }
    return { action: "allow", reason: `model_cache_${advice.status}` };
  }
}
