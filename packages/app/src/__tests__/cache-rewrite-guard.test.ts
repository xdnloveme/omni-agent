import { describe, expect, it } from "vitest";
import type { ModelCacheLeaseAdvisorPort, RuntimeModelSelection } from "@omni-agent/core";
import { CacheBackedContextRewriteGuard } from "../context";

const selection: RuntimeModelSelection = {
  vendorId: "test",
  connectionId: "default",
  providerId: "test",
  modelId: "model",
  contextWindow: 100_000,
  modelMaxOutputTokens: 1_000,
  requestedOutputTokens: 1_000,
};

describe("CacheBackedContextRewriteGuard", () => {
  it("defers only an active lease with known expiry", () => {
    let currentSelection = selection;
    const advisor: ModelCacheLeaseAdvisorPort = {
      inspect: (model) =>
        model.modelId === "model"
          ? {
              status: "active",
              scopeId: "scope",
              retention: "short",
              expiresAt: 5_000,
            }
          : { status: "cold", scopeId: "scope-2", retention: "short" },
    };
    const guard = new CacheBackedContextRewriteGuard(advisor, () => currentSelection);

    expect(guard.assess(input())).toEqual({
      action: "defer",
      reason: "model_cache_lease_active",
      reconsiderAt: 5_000,
    });
    currentSelection = { ...selection, modelId: "model-2" };
    expect(guard.assess(input())).toEqual({
      action: "allow",
      reason: "model_cache_cold",
    });
  });

  it.each(["disabled", "cold", "expired", "unknown_expiry"] as const)(
    "allows rewrites for %s cache state",
    (status) => {
      const advisor: ModelCacheLeaseAdvisorPort = {
        inspect: () => ({ status, scopeId: "scope", retention: "short" }),
      };
      expect(new CacheBackedContextRewriteGuard(advisor, () => selection).assess(input())).toEqual({
        action: "allow",
        reason: `model_cache_${status}`,
      });
    },
  );
});

function input() {
  return {
    agentId: "coding",
    sessionId: "session-1",
    modelCallId: "call-1",
    estimate: {
      systemPromptTokens: 1,
      messageTokens: 1,
      toolTokens: 1,
      totalInputTokens: 3,
      usableInputBudget: 100,
      usageRatio: 0.03,
    },
  };
}
