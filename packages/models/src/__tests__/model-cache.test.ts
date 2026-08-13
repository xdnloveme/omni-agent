import { describe, expect, it } from "vitest";
import type {
  AssistantTranscriptMessage,
  ModelEvent,
  ModelRequest,
  RuntimeModelSelection,
} from "@omni-agent/core";
import {
  CacheAwareModelRuntime,
  type ModelRuntimeExecutionOptions,
  type ModelTransportRuntimePort,
} from "../cache/cacheAwareRuntime";
import { resolveModelCacheCapability } from "../cache/capability";
import { ModelCacheFingerprinter } from "../cache/fingerprint";
import { DefaultModelCachePolicy } from "../cache/policy";
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
  maxOutputTokens: 4_096,
};

const request: ModelRequest = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

describe("model cache infrastructure", () => {
  it("keeps a stable scope and classifies appended messages deterministically", async () => {
    const seen: ModelRuntimeExecutionOptions[] = [];
    const runtime = new CacheAwareModelRuntime(
      successfulTransport(seen),
      new DefaultModelCachePolicy(),
      () => resolveModelCacheCapability("anthropic-messages"),
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
    expect(seen[0]?.providerCache.sessionId).toBe(firstReport?.report.scopeId);
    expect(first.map((event) => event.type)).toEqual(["text_delta", "cache_report", "done"]);
  });

  it("keeps auxiliary calls cache-disabled and out of runtime cache state", async () => {
    const seen: ModelRuntimeExecutionOptions[] = [];
    const runtime = new CacheAwareModelRuntime(
      successfulTransport(seen),
      new DefaultModelCachePolicy(),
      () => resolveModelCacheCapability("anthropic-messages"),
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
    expect(reportOf(second).lifecycle).toBe("cold");
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerCache: { cacheRetention: "none" } }),
      ]),
    );
  });

  it("keeps the last successful baseline when a later request fails", async () => {
    let call = 0;
    const runtime = new CacheAwareModelRuntime(
      {
        async *stream(): AsyncIterable<ModelEvent> {
          call++;
          if (call === 2) {
            yield { type: "error", error: { ...assistant("failed"), stopReason: "error" } };
            return;
          }
          yield { type: "done", message: assistant("ok") };
        },
      },
      new DefaultModelCachePolicy(),
      () => resolveModelCacheCapability("anthropic-messages"),
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
    const capability = resolveModelCacheCapability("google-generative-ai");
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
    expect(resolveModelCacheCapability("omni-custom")).toEqual({
      mode: "none",
      retentions: ["none"],
      supportsStableScopeKey: false,
    });
    expect(
      resolveModelCacheCapability("omni-custom", {
        mode: "automatic_prefix",
        retentions: ["none", "short"],
        supportsStableScopeKey: true,
      }),
    ).toMatchObject({ mode: "automatic_prefix", supportsStableScopeKey: true });
  });
});

function successfulTransport(seen: ModelRuntimeExecutionOptions[]): ModelTransportRuntimePort {
  return {
    async *stream(_selection, _request, options): AsyncIterable<ModelEvent> {
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
  return {
    identity: primaryOptions("call").identity,
    directive: { scopeId: "scope", retention: "short", semanticsVersion: 1 },
    fingerprint,
    createdAt: 0,
  };
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
