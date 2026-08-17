import { describe, expect, it } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import type {
  AssistantTranscriptMessage,
  ModelEvent,
  ModelRequest,
  RuntimeModelSelection,
} from "@omni-agent/core";
import { CacheAwareModelRuntime } from "../cache/cacheAwareRuntime";
import { ModelCacheCoordinator } from "../cache/coordinator";
import { normalizeModelCacheCapability, resolveModelCacheCapability } from "../cache/capability";
import type {
  ModelTransportEvent,
  ModelTransportExecutionOptions,
  ModelTransportRuntimePort,
} from "../cache/contracts";
import { ModelCacheFingerprinter } from "../cache/fingerprint";
import { DefaultModelCachePolicy } from "../cache/policy";
import { toProviderCacheOptions } from "../cache/providerAdapter";
import { createProviderContribution } from "../vendors/provider-contribution";
import {
  compareModelCacheState,
  RuntimeModelCacheState,
  type RuntimeModelCacheEntry,
} from "../cache/state";

const selection: RuntimeModelSelection = {
  vendorId: "test",
  connectionId: "default",
  providerId: "anthropic",
  modelId: "claude-test",
  contextWindow: 128_000,
  modelMaxOutputTokens: 4_096,
  requestedOutputTokens: 4_096,
};

const request: ModelRequest = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

describe("model cache infrastructure", () => {
  it("keeps a stable scope and classifies appended messages deterministically", async () => {
    const seen: ModelTransportExecutionOptions[] = [];
    const runtime = new CacheAwareModelRuntime(
      successfulTransport(seen),
      new DefaultModelCachePolicy(),
      () => capability("anthropic-messages", { sendSessionAffinityHeaders: true }),
    );

    const first = await collect(runtime.stream(selection, request, primaryOptions("call-1")));
    const second = await collect(
      runtime.stream(
        selection,
        {
          ...request,
          messages: [...request.messages, assistant("answer"), { role: "user", content: "next" }],
        },
        primaryOptions("call-2"),
      ),
    );

    const firstReport = first.find((event) => event.type === "cache_report");
    const secondReport = second.find((event) => event.type === "cache_report");
    expect(firstReport?.report.lifecycle).toBe("cold");
    expect(secondReport?.report.lifecycle).toBe("append_only");
    expect(secondReport?.report.scopeId).toBe(firstReport?.report.scopeId);
    expect(seen[0]?.providerCache).toMatchObject({ cacheRetention: "short" });
    expect(seen[0]?.maxOutputTokens).toBe(selection.requestedOutputTokens);
    expect(seen[0]?.providerCache.sessionId).toBe(firstReport?.report.scopeId);
    expect(first.map((event) => event.type)).toEqual(["text_delta", "cache_report", "done"]);
  });

  it("passes thinking events through without treating them as terminal", async () => {
    const runtime = new CacheAwareModelRuntime(
      {
        async *stream(): AsyncIterable<ModelTransportEvent> {
          yield { type: "thinking_start", contentIndex: 0 };
          yield { type: "thinking_delta", contentIndex: 0, delta: "checking" };
          yield { type: "thinking_end", contentIndex: 0, content: "checking" };
          yield { type: "done", message: assistant("done") };
        },
      },
      new DefaultModelCachePolicy(),
      () => capability("anthropic-messages"),
    );

    const events = await collect(runtime.stream(selection, request, primaryOptions("thinking")));
    expect(events.map((event) => event.type)).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "cache_report",
      "done",
    ]);
  });

  it("exposes a detached active lease after a successful call", async () => {
    const runtime = new CacheAwareModelRuntime(
      successfulTransport([]),
      new DefaultModelCachePolicy(),
      () => capability("anthropic-messages"),
    );
    expect(
      runtime.leaseAdvisor.inspect(selection, primaryOptions("before").identity, {
        retention: "default",
      }).status,
    ).toBe("cold");
    await collect(runtime.stream(selection, request, primaryOptions("call-1")));
    expect(
      runtime.leaseAdvisor.inspect(selection, primaryOptions("after").identity, {
        retention: "default",
      }),
    ).toMatchObject({ status: "active", retention: "short" });

    const unknownTtlRuntime = new CacheAwareModelRuntime(
      successfulTransport([]),
      new DefaultModelCachePolicy(),
      () => capability("openai-responses"),
    );
    await collect(unknownTtlRuntime.stream(selection, request, primaryOptions("unknown-1")));
    expect(
      unknownTtlRuntime.leaseAdvisor.inspect(selection, primaryOptions("unknown-2").identity, {
        retention: "default",
      }).status,
    ).toBe("unknown_expiry");
  });

  it("inspects expiry without consuming the next lifecycle classification", () => {
    let now = 1_000;
    const coordinator = new ModelCacheCoordinator(
      new DefaultModelCachePolicy(),
      () => capability("anthropic-messages"),
      undefined,
      undefined,
      () => now,
    );
    const prepared = coordinator.prepare(selection, request, primaryOptions("call-1").identity, {
      retention: "default",
    });
    coordinator.recordSuccess({
      scopeId: prepared.decision.directive.scopeId,
      retention: prepared.decision.directive.retention as "short",
      capability: prepared.capability,
      fingerprint: prepared.fingerprint,
    });
    now += 300_000;

    expect(
      coordinator.inspect(selection, primaryOptions("inspect").identity, {
        retention: "default",
      }).status,
    ).toBe("expired");
    expect(
      coordinator.prepare(selection, request, primaryOptions("next").identity, {
        retention: "default",
      }).comparison.lifecycle,
    ).toBe("expired");
  });

  it("keeps auxiliary calls cache-disabled and out of runtime cache state", async () => {
    const seen: ModelTransportExecutionOptions[] = [];
    const runtime = new CacheAwareModelRuntime(
      successfulTransport(seen),
      new DefaultModelCachePolicy(),
      () => capability("anthropic-messages", { sendSessionAffinityHeaders: true }),
    );
    const options = {
      ...primaryOptions("summary-1"),
      identity: { ...primaryOptions("summary-1").identity, purpose: "auxiliary" as const },
      cache: { retention: "default" as const },
    };

    const first = await collect(runtime.stream(selection, request, options));
    const second = await collect(
      runtime.stream(selection, request, {
        ...options,
        identity: { ...options.identity, modelCallId: "summary-2" },
      }),
    );

    expect(reportOf(first).appliedRetention).toBe("none");
    expect(reportOf(first).cacheHitRate).toBeUndefined();
    expect(reportOf(second).lifecycle).toBe("cold");
    expect(seen.every((entry) => entry.providerCache.sessionId === undefined)).toBe(true);
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerCache: { cacheRetention: "none" } }),
      ]),
    );
  });

  it("reports real provider token cache hit rate without counting cache writes as hits", async () => {
    const runtime = new CacheAwareModelRuntime(
      {
        async *stream(): AsyncIterable<ModelTransportEvent> {
          yield {
            type: "done",
            message: {
              ...assistant("ok"),
              usage: { input: 40, output: 1, cacheRead: 50, cacheWrite: 10 },
            },
          };
        },
      },
      new DefaultModelCachePolicy(),
      () => capability("anthropic-messages"),
    );

    const report = reportOf(
      await collect(runtime.stream(selection, request, primaryOptions("hit"))),
    );
    expect(report.inputTokens).toBe(40);
    expect(report.cacheHitRate).toBe(0.5);
  });

  it("keeps the last successful baseline when a later request fails", async () => {
    let call = 0;
    const runtime = new CacheAwareModelRuntime(
      {
        async *stream(): AsyncIterable<ModelTransportEvent> {
          call++;
          if (call === 2) {
            yield { type: "error", error: { ...assistant("failed"), stopReason: "error" } };
            return;
          }
          yield { type: "done", message: assistant("ok") };
        },
      },
      new DefaultModelCachePolicy(),
      () => capability("anthropic-messages"),
    );
    const changed = { ...request, messages: [{ role: "user" as const, content: "changed" }] };

    await collect(runtime.stream(selection, request, primaryOptions("call-1")));
    expect(
      reportOf(await collect(runtime.stream(selection, changed, primaryOptions("call-2")))).outcome,
    ).toBe("failed");
    expect(
      reportOf(await collect(runtime.stream(selection, changed, primaryOptions("call-3"))))
        .lifecycle,
    ).toBe("tail_changed");
  });

  it("changes scope with the Session and never downgrades unsupported long retention", () => {
    const policy = new DefaultModelCachePolicy();
    const capability = resolveModelCacheCapability({
      api: "google-generative-ai",
      baseUrl: "https://google.test",
    });
    const first = policy.resolve({
      identity: primaryOptions("call-1").identity,
      intent: { retention: "long" },
      capability,
      selection,
    });
    const nextSession = policy.resolve({
      identity: { ...primaryOptions("call-2").identity, sessionId: "session-2" },
      intent: { retention: "long" },
      capability,
      selection,
    });

    expect(first.directive.retention).toBe("none");
    expect(first.reason).toContain("not supported");
    expect(nextSession.directive.scopeId).not.toBe(first.directive.scopeId);
  });

  it("uses fixed lifecycle rules for tail changes, rebases, expiry, and incompatibility", () => {
    const fingerprinter = new ModelCacheFingerprinter();
    const base = fingerprinter.fingerprint(selection, request);
    const entry = cacheEntry(base);
    const tailChanged = fingerprinter.fingerprint(selection, {
      ...request,
      messages: [{ role: "user", content: "changed" }],
    });
    const rebased = fingerprinter.fingerprint(selection, {
      ...request,
      systemPrompt: "different system",
    });
    const incompatible = fingerprinter.fingerprint(
      { ...selection, settings: { reasoning: "high" } },
      request,
    );

    expect(compareModelCacheState(entry, tailChanged, 1).lifecycle).toBe("tail_changed");
    expect(compareModelCacheState(entry, rebased, 1).lifecycle).toBe("rebased");
    expect(compareModelCacheState({ ...entry, expiresAt: 1 }, base, 1).lifecycle).toBe("expired");
    expect(compareModelCacheState(entry, incompatible, 1).lifecycle).toBe("incompatible");
  });

  it("bounds state with LRU eviction and returns detached entries", () => {
    const state = new RuntimeModelCacheState(2);
    const fingerprint = new ModelCacheFingerprinter().fingerprint(selection, request);
    state.set("one", cacheEntry(fingerprint));
    state.set("two", cacheEntry(fingerprint));
    expect(state.get("one")).toBeDefined();
    state.set("three", cacheEntry(fingerprint));

    expect(state.get("two")).toBeUndefined();
    const detached = state.get("one");
    expect(detached).toBeDefined();
    expect(detached?.fingerprint.messageDigests).not.toBe(fingerprint.messageDigests);
  });

  it("treats unknown custom transports as cache-disabled unless explicitly declared", () => {
    expect(
      resolveModelCacheCapability({ api: "omni-custom", baseUrl: "https://custom.test" }),
    ).toEqual({
      mode: "none",
      retentions: ["none"],
      supportsStableScopeKey: false,
    });
    expect(
      resolveModelCacheCapability({
        api: "omni-custom",
        baseUrl: "https://custom.test",
        explicit: {
          mode: "automatic_prefix",
          retentions: ["none", "short"],
          supportsStableScopeKey: true,
        },
      }),
    ).toMatchObject({ mode: "automatic_prefix", supportsStableScopeKey: true });
  });

  it("derives capability from protocol, base URL, and compat flags", () => {
    expect(capability("anthropic-messages")).toMatchObject({
      retentions: ["none", "short", "long"],
      supportsStableScopeKey: false,
      shortTtlMs: 300_000,
      longTtlMs: 3_600_000,
    });
    expect(capability("anthropic-messages", { supportsLongCacheRetention: false })).toEqual({
      mode: "explicit_breakpoint",
      retentions: ["none", "short"],
      supportsStableScopeKey: false,
      shortTtlMs: 300_000,
    });
    expect(
      capability("anthropic-messages", {
        supportsLongCacheRetention: false,
        sendSessionAffinityHeaders: true,
      }),
    ).toMatchObject({ retentions: ["none", "short"], supportsStableScopeKey: true });
    expect(capability("openai-responses")).toMatchObject({
      retentions: ["none", "short", "long"],
      supportsStableScopeKey: true,
      longTtlMs: 86_400_000,
    });
    expect(capability("openai-responses", { supportsLongCacheRetention: false })).toEqual({
      mode: "automatic_prefix",
      retentions: ["none", "short"],
      supportsStableScopeKey: true,
    });
    expect(capability("openai-completions")).toMatchObject({
      retentions: ["none", "short", "long"],
      supportsStableScopeKey: true,
      longTtlMs: 86_400_000,
    });
    expect(capability("openai-completions", { supportsLongCacheRetention: false })).toEqual({
      mode: "automatic_prefix",
      retentions: ["none", "short"],
      supportsStableScopeKey: false,
    });
    expect(
      capability("openai-completions", {
        supportsLongCacheRetention: false,
        sendSessionAffinityHeaders: true,
      }),
    ).toMatchObject({ retentions: ["none", "short"], supportsStableScopeKey: true });
    expect(
      resolveModelCacheCapability({
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        compat: { supportsLongCacheRetention: false },
      }),
    ).toMatchObject({ supportsStableScopeKey: true });
    expect(capability("google-generative-ai")).toMatchObject({
      mode: "automatic_prefix",
      supportsStableScopeKey: false,
    });
    expect(capability("mistral-conversations")).toMatchObject({
      mode: "automatic_prefix",
      supportsStableScopeKey: true,
    });
  });

  it("rejects inconsistent capabilities and suppresses scope when cache is disabled", () => {
    expect(() =>
      normalizeModelCacheCapability({
        mode: "none",
        retentions: ["none", "short"],
        supportsStableScopeKey: false,
      }),
    ).toThrow("Disabled model cache capability");
    expect(() =>
      normalizeModelCacheCapability({
        mode: "automatic_prefix",
        retentions: ["none", "short"],
        supportsStableScopeKey: true,
        longTtlMs: 1,
      }),
    ).toThrow("requires long retention support");
    expect(
      toProviderCacheOptions(
        { scopeId: "scope", retention: "none" },
        capability("openai-responses"),
      ),
    ).toEqual({ cacheRetention: "none" });
    expect(() =>
      createProviderContribution(
        fauxProvider({ provider: "invalid-cache", models: [{ id: "model" }] }).provider,
        [],
        {
          mode: "none",
          retentions: ["none", "short"],
          supportsStableScopeKey: false,
        },
      ),
    ).toThrow("Disabled model cache capability");
  });
});

function successfulTransport(seen: ModelTransportExecutionOptions[]): ModelTransportRuntimePort {
  return {
    async *stream(_selection, _request, options): AsyncIterable<ModelTransportEvent> {
      seen.push(options);
      yield { type: "text_delta", delta: "ok" };
      yield { type: "done", message: assistant("ok") };
    },
  };
}

function primaryOptions(modelCallId: string) {
  return {
    identity: {
      agentId: "coding",
      sessionId: "session-1",
      modelCallId,
      contextSnapshotId: `snapshot-${modelCallId}`,
      purpose: "primary" as const,
    },
    cache: { retention: "default" as const },
  };
}

function assistant(text: string): AssistantTranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    timestamp: 1,
  };
}

function cacheEntry(fingerprint: RuntimeModelCacheEntry["fingerprint"]): RuntimeModelCacheEntry {
  return { fingerprint, retention: "short" };
}

function capability(api: string, compat?: Record<string, unknown>) {
  return resolveModelCacheCapability({ api, baseUrl: "https://provider.test", compat });
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const output: ModelEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

function reportOf(events: readonly ModelEvent[]) {
  const event = events.find((candidate) => candidate.type === "cache_report");
  if (!event || event.type !== "cache_report") throw new Error("Missing cache report");
  return event.report;
}
