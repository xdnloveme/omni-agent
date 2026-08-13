import type {
  ModelCacheCapability,
  ModelCachePolicyPort,
  ModelCacheReport,
  ModelEvent,
  ModelRequest,
  ModelRequestOptions,
  ModelRuntimePort,
  RuntimeModelSelection,
} from "@omni-agent/core";
import type { ModelTransportExecutionOptions, ModelTransportRuntimePort } from "./contracts";
import { ModelCacheFingerprinter } from "./fingerprint";
import { toProviderCacheOptions } from "./providerAdapter";
import { compareModelCacheState, resolveCacheExpiry, RuntimeModelCacheState } from "./state";

type ModelCacheCapabilityResolver = (selection: RuntimeModelSelection) => ModelCacheCapability;

export class CacheAwareModelRuntime implements ModelRuntimePort {
  constructor(
    private readonly inner: ModelTransportRuntimePort,
    private readonly policy: ModelCachePolicyPort,
    private readonly capabilities: ModelCacheCapabilityResolver,
    private readonly fingerprinter = new ModelCacheFingerprinter(),
    private readonly state = new RuntimeModelCacheState(),
  ) {}

  async *stream(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    options: ModelRequestOptions,
  ): AsyncIterable<ModelEvent> {
    const capability = this.capabilities(selection);
    const decision = this.policy.resolve({
      identity: options.identity,
      intent: options.cache,
      capability,
      selection,
    });
    const fingerprint = this.fingerprinter.fingerprint(selection, request);
    const now = Date.now();
    const previous =
      decision.directive.retention === "none"
        ? undefined
        : this.state.get(decision.directive.scopeId, now);
    const comparison = compareModelCacheState(previous, fingerprint, now);
    const executionOptions: ModelTransportExecutionOptions = {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      maxOutputTokens: options.maxOutputTokens,
      credential: options.credential,
      providerCache: toProviderCacheOptions(decision.directive, capability),
    };
    let terminalObserved = false;
    try {
      for await (const event of this.inner.stream(selection, request, executionOptions)) {
        if (event.type === "text_delta") {
          yield event;
          continue;
        }
        terminalObserved = true;
        const outcome =
          event.type === "done"
            ? "success"
            : event.error.stopReason === "aborted"
              ? "cancelled"
              : "failed";
        const usage = event.type === "done" ? event.message.usage : event.error.usage;
        const report = createReport({
          outcome,
          options,
          capability,
          decision,
          comparison,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
        });
        if (outcome === "success" && decision.directive.retention !== "none") {
          const createdAt = Date.now();
          // Failed and cancelled requests must never replace the last successful baseline.
          this.state.set(decision.directive.scopeId, {
            fingerprint,
            expiresAt: resolveCacheExpiry(decision.directive, capability, createdAt),
          });
        }
        yield { type: "cache_report", report };
        yield event;
        return;
      }
      throw new Error("Model runtime ended without a terminal event");
    } catch (error) {
      if (terminalObserved) throw error;
      const cancelled = options.signal?.aborted === true;
      yield {
        type: "cache_report",
        report: createReport({
          outcome: cancelled ? "cancelled" : "failed",
          options,
          capability,
          decision,
          comparison,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      };
      throw error;
    }
  }

  clear(): void {
    this.state.clear();
  }
}

function createReport(input: {
  readonly outcome: ModelCacheReport["outcome"];
  readonly options: ModelRequestOptions;
  readonly capability: ModelCacheCapability;
  readonly decision: ReturnType<ModelCachePolicyPort["resolve"]>;
  readonly comparison: ReturnType<typeof compareModelCacheState>;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}): ModelCacheReport {
  return {
    outcome: input.outcome,
    modelCallId: input.options.identity.modelCallId,
    contextSnapshotId: input.options.identity.contextSnapshotId,
    scopeId: input.decision.directive.scopeId,
    requestedRetention: input.options.cache.retention,
    appliedRetention: input.decision.directive.retention,
    capability: {
      ...input.capability,
      retentions: [...input.capability.retentions],
    },
    ...input.comparison,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    reason: input.decision.reason ?? lifecycleReason(input.comparison.lifecycle),
    createdAt: Date.now(),
  };
}

function lifecycleReason(lifecycle: ModelCacheReport["lifecycle"]): string | undefined {
  switch (lifecycle) {
    case "expired":
      return "Known Provider cache TTL expired";
    case "incompatible":
      return "Model request semantics changed";
    case "rebased":
      return "Static prefix or conversation base changed";
    case "prefix_rewritten":
      return "A previously cached message prefix changed";
    case "tail_changed":
      return "The final model-context message changed";
    default:
      return undefined;
  }
}
