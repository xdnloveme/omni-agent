import type {
  ModelCacheCapability,
  ModelCachePolicyDecision,
  ModelCachePolicyInput,
  ModelCachePolicyPort,
  ModelCacheRetention,
} from "@omni-agent/core";
import { digestCacheValue, MODEL_CACHE_SEMANTICS_VERSION } from "./fingerprint";

export class DefaultModelCachePolicy implements ModelCachePolicyPort {
  resolve(input: ModelCachePolicyInput): ModelCachePolicyDecision {
    const requested = resolveRequestedRetention(input);
    const supported = supports(input.capability, requested);
    const retention = supported ? requested : "none";
    return {
      directive: {
        scopeId: createScopeId(input),
        retention,
      },
      ...(!supported
        ? {
            reason: `Cache retention ${requested} is not supported for ${input.selection.providerId}/${input.selection.modelId}`,
          }
        : {}),
    };
  }
}

function resolveRequestedRetention(input: ModelCachePolicyInput): ModelCacheRetention {
  if (input.intent.retention !== "default") return input.intent.retention;
  return input.identity.purpose === "primary" ? "short" : "none";
}

function supports(capability: ModelCacheCapability, retention: ModelCacheRetention): boolean {
  return capability.retentions.includes(retention);
}

function createScopeId(input: ModelCachePolicyInput): string {
  return digestCacheValue({
    agentId: input.identity.agentId,
    sessionId: input.identity.sessionId,
    providerId: input.selection.providerId,
    modelId: input.selection.modelId,
    requestModelId: input.selection.requestModelId,
    semanticsVersion: MODEL_CACHE_SEMANTICS_VERSION,
  });
}
