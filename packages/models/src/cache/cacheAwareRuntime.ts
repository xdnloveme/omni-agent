import type {
  ModelCacheCapability,
  ModelCacheLeaseAdvisorPort,
  ModelCachePolicyPort,
  ModelCacheReport,
  ModelEvent,
  ModelRequest,
  ModelRequestOptions,
  ModelRuntimePort,
  RuntimeModelSelection,
} from "@omni-agent/core";
import type { ModelTransportExecutionOptions, ModelTransportRuntimePort } from "./contracts";
import { ModelCacheCoordinator } from "./coordinator";
import { ModelCacheFingerprinter } from "./fingerprint";
import { toProviderCacheOptions } from "./providerAdapter";
import { RuntimeModelCacheState, type ModelCacheComparison } from "./state";

type ModelCacheCapabilityResolver = (selection: RuntimeModelSelection) => ModelCacheCapability;

export class CacheAwareModelRuntime implements ModelRuntimePort {
  readonly leaseAdvisor: ModelCacheLeaseAdvisorPort;
  private readonly coordinator: ModelCacheCoordinator;

  constructor(
    private readonly inner: ModelTransportRuntimePort,
    policy: ModelCachePolicyPort,
    capabilities: ModelCacheCapabilityResolver,
    fingerprinter = new ModelCacheFingerprinter(),
    state = new RuntimeModelCacheState(),
  ) {
    this.coordinator = new ModelCacheCoordinator(policy, capabilities, fingerprinter, state);
    this.leaseAdvisor = this.coordinator;
  }

  async *stream(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    options: ModelRequestOptions,
  ): AsyncIterable<ModelEvent> {
    const { capability, decision, fingerprint, comparison } = this.coordinator.prepare(
      selection,
      request,
      options.identity,
      options.cache,
    );
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
          inputTokens: usage.input,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
        });
        if (outcome === "success" && decision.directive.retention !== "none") {
          // Failed and cancelled requests must never replace the last successful baseline.
          this.coordinator.recordSuccess({
            scopeId: decision.directive.scopeId,
            retention: decision.directive.retention,
            capability,
            fingerprint,
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
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      };
      throw error;
    }
  }

  clear(): void {
    this.coordinator.clear();
  }
}

function createReport(input: {
  readonly outcome: ModelCacheReport["outcome"];
  readonly options: ModelRequestOptions;
  readonly capability: ModelCacheCapability;
  readonly decision: ReturnType<ModelCachePolicyPort["resolve"]>;
  readonly comparison: ModelCacheComparison;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}): ModelCacheReport {
  const totalPromptTokens = input.inputTokens + input.cacheReadTokens + input.cacheWriteTokens;
  const cacheHitRate =
    input.outcome === "success" &&
    input.capability.mode !== "none" &&
    input.decision.directive.retention !== "none" &&
    totalPromptTokens > 0
      ? input.cacheReadTokens / totalPromptTokens
      : undefined;
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
    inputTokens: input.inputTokens,
    ...(cacheHitRate === undefined ? {} : { cacheHitRate }),
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
