import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelRequest, ToolInputConstraint } from "@omni-agent/core";
import { ModelRuntime } from "../runtime/model-runtime";
import {
  configuredToolConstraintCapability,
  resolveToolConstraints,
} from "../runtime/tool-constraints";
import { VendorRegistry } from "../vendors/registry";
import { defineVendor } from "../vendors/define-vendor";
import { compatibleConnection } from "../providers/factories/compatible";
import { transportConnection } from "../providers/factories/transport";
import type { CompatibleProtocol, ModelTransportRequest } from "../providers/custom/types";
import type { CredentialStore } from "../credentials/types";
import { CacheAwareModelRuntime } from "../cache/cacheAwareRuntime";
import { DefaultModelCachePolicy } from "../cache/policy";
import { ModelCacheFingerprinter } from "../cache/fingerprint";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: { value: { type: "string" } },
  required: ["value"],
};
const selection = {
  vendorId: "constraint",
  connectionId: "default",
  providerId: "constraint",
  modelId: "model",
  contextWindow: 32_000,
  modelMaxOutputTokens: 1024,
  requestedOutputTokens: 1024,
};
const options = { providerCache: { cacheRetention: "none" as const }, maxOutputTokens: 1024 };
const credentials: CredentialStore = {
  read: async () => ({ type: "api_key", key: "test-key" }),
  list: async () => [],
  modify: async () => undefined,
  delete: async () => {},
};
const managers: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.unstubAllGlobals();
});
function request(inputConstraint?: ToolInputConstraint, toolSchema = schema): ModelRequest {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "test" }],
    tools: [
      {
        name: "inspect",
        description: "Inspect",
        schema: toolSchema,
        ...(inputConstraint === undefined ? {} : { inputConstraint }),
      },
    ],
  };
}
async function setup(
  supported?: boolean,
  protocol: CompatibleProtocol = "openai-completions",
  modelSupported?: boolean,
) {
  const payloads: any[] = [];
  const fetch = vi.fn(
    async () =>
      new Response(
        'data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const runtime = new ModelRuntime({
    credentials,
    onPayload: (payload) => {
      payloads.push(payload);
    },
  });
  const manager = runtime.createPluginManager(new VendorRegistry());
  managers.push(manager);
  await manager.register(
    defineVendor({
      id: "constraint",
      displayName: "Constraint",
      connections: [
        compatibleConnection({
          id: "default",
          displayName: "Default",
          providerId: "constraint",
          providerName: "Constraint",
          baseUrl: "https://constraint.invalid/v1",
          envVars: ["TEST_KEY"],
          protocol,
          ...(supported === undefined ? {} : { compat: { supportsStrictMode: supported } }),
          models: [
            {
              id: "model",
              contextWindow: 32_000,
              maxTokens: 1024,
              ...(modelSupported === undefined ? {} : { supportsStrictMode: modelSupported }),
            },
          ],
        }),
      ],
    }),
  );
  return { runtime, payloads, fetch };
}
async function drain(
  runtime: ModelRuntime,
  req: ModelRequest,
  events: ModelEvent[] = [],
  override = selection,
) {
  for await (const event of runtime.stream(override, req, options)) events.push(event);
  return events;
}
function report(events: ModelEvent[]) {
  const event = events.find((event) => event.type === "tool_constraint_report");
  if (!event || event.type !== "tool_constraint_report") throw new Error("No constraint report");
  return event.report;
}

describe("Provider tool constraint boundary", () => {
  it("serializes resolved intent and preserves the original schema", async () => {
    const { runtime, payloads } = await setup(true);
    for (const intent of ["prefer", "require", "off", undefined] as const) {
      const req = request(intent);
      const before = structuredClone(req);
      const events = await drain(runtime, req);
      const enabled = intent === "prefer" || intent === "require";
      expect(payloads.at(-1).tools[0].function).toMatchObject({
        strict: enabled,
        parameters: schema,
      });
      expect(report(events).decisions[0]).toMatchObject({
        intent: intent ?? "unspecified",
        outcome: enabled ? "enabled" : "disabled",
        capability: { state: "supported", source: "connection" },
      });
      expect(req).toEqual(before);
    }
  });

  it.each([false, undefined])(
    "does not send require requests to unsupported/unknown providers: %s",
    async (supported) => {
      const { runtime, fetch } = await setup(supported);
      const events: ModelEvent[] = [];
      await expect(drain(runtime, request("require"), events)).rejects.toMatchObject({
        code: "model_tool_constraint_unsatisfied",
        retryable: false,
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(report(events)).toMatchObject({
        failure: { retryable: false },
        decisions: [
          {
            outcome: "rejected",
            reason: supported === false ? "capability_unsupported" : "capability_unknown",
          },
        ],
      });
      const preferred = await drain(runtime, request("prefer"));
      expect(report(preferred).decisions[0].outcome).toBe("disabled");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not turn optional properties into required or nullable properties", async () => {
    const { runtime, fetch, payloads } = await setup(true);
    const optional = { ...schema, required: [] };
    const events = await drain(runtime, request("prefer", optional));
    expect(payloads[0].tools[0].function).toMatchObject({ strict: false, parameters: optional });
    expect(report(events).decisions[0]).toMatchObject({
      schema: "incompatible",
      reason: "schema_optional_properties",
    });
    await expect(drain(runtime, request("require", optional))).rejects.toMatchObject({
      code: "model_tool_constraint_unsatisfied",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lets explicit model declarations override connections and distrusts deployment overrides", async () => {
    const { runtime, payloads, fetch } = await setup(false, "openai-completions", true);
    expect(report(await drain(runtime, request("require"))).decisions[0].capability).toEqual({
      state: "supported",
      source: "model",
    });
    expect(payloads[0].tools[0].function.strict).toBe(true);
    await expect(
      drain(runtime, request("require"), [], {
        ...selection,
        requestModelId: "another-deployment",
      } as typeof selection),
    ).rejects.toMatchObject({ code: "model_tool_constraint_unsatisfied" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["openai-responses", "anthropic-messages"] as const)(
    "uses the existing %s protocol serializer",
    async (protocol) => {
      const { runtime, payloads, fetch } = await setup(true, protocol);
      // Payload observation happens before fetch; interrupt there so no fake response protocol is needed.
      fetch.mockImplementation(async () => {
        throw new Error("local probe stops after serialization");
      });
      await drain(runtime, request("require"));
      expect(payloads[0].tools[0]).toMatchObject({ name: "inspect", strict: true });
      expect(fetch).toHaveBeenCalled();
    },
  );

  it("reports unverified schema features without stripping them or enabling unknown protocols", () => {
    const capability = { state: "supported", source: "model" } as const;
    const constrained = request("prefer", {
      ...schema,
      properties: { value: { type: "string", minLength: 1 } },
    } as typeof schema);
    expect(
      resolveToolConstraints(constrained.tools, "openai-completions", capability).decisions[0],
    ).toMatchObject({
      outcome: "disabled",
      schema: "unknown",
      reason: "schema_keyword_not_verified",
    });
    expect(
      resolveToolConstraints(request("require").tools, "google-generative-ai", capability)
        .decisions[0],
    ).toMatchObject({
      outcome: "rejected",
      schema: "unknown",
      reason: "protocol_schema_not_verified",
    });
  });

  it.each([true, false, undefined])(
    "carries the resolved requirement through the custom transport bridge: %s",
    async (supported) => {
      const seen: ModelTransportRequest[] = [];
      const runtime = new ModelRuntime({ credentials });
      const manager = runtime.createPluginManager(new VendorRegistry());
      managers.push(manager);
      await manager.register(
        defineVendor({
          id: "constraint",
          displayName: "Constraint",
          connections: [
            transportConnection({
              id: "default",
              displayName: "Default",
              providerId: "constraint",
              providerName: "Constraint",
              baseUrl: "https://constraint.invalid",
              envVars: ["TEST_KEY"],
              supportsStrictMode: supported,
              models: [{ id: "model", contextWindow: 32_000, maxTokens: 1024 }],
              transport: {
                async *stream(_model, req) {
                  seen.push(req);
                  yield {
                    type: "done",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "ok" }],
                      stopReason: "stop",
                      api: "omni-custom",
                      provider: "constraint",
                      model: "model",
                      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                      timestamp: 0,
                    },
                  };
                },
              },
            }),
          ],
        }),
      );
      if (supported !== true) {
        await expect(drain(runtime, request("require"))).rejects.toMatchObject({
          code: "model_tool_constraint_unsatisfied",
        });
        expect(seen).toHaveLength(0);
      }
      await drain(runtime, request("prefer"));
      await drain(runtime, request("off"));
      expect(seen.map((req) => req.tools[0].inputConstraint)).toEqual([
        supported === true ? "require" : "off",
        "off",
      ]);
      expect(seen[0].tools[0].schema).toEqual(schema);
    },
  );

  it("keeps the compiled request stable while reporting its decision", async () => {
    const { runtime, payloads } = await setup(true);
    const req = request("require", structuredClone(schema));
    for await (const event of runtime.stream(selection, req, options)) {
      if (event.type === "tool_constraint_report") {
        (req.tools![0].schema as typeof schema).properties.value.type = "number";
      }
    }
    expect(payloads[0].tools[0].function.parameters).toEqual(schema);
  });

  it("rejects an already-cancelled request before decision, credentials or network work", async () => {
    const { runtime, fetch } = await setup(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      (async () => {
        for await (const _ of runtime.stream(selection, request("require"), {
          ...options,
          signal: controller.signal,
        })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards decision reports through the cache wrapper without treating them as a response", async () => {
    const { runtime } = await setup(true);
    const wrapped = new CacheAwareModelRuntime(runtime, new DefaultModelCachePolicy(), () => ({
      mode: "none",
      retentions: ["none"],
      stableScopeRetentions: [],
    }));
    const events: ModelEvent[] = [];
    for await (const event of wrapped.stream(selection, request("prefer"), {
      identity: {
        agentId: "test",
        sessionId: "test",
        modelCallId: "call",
        contextSnapshotId: "snapshot",
        purpose: "primary",
      },
      cache: { retention: "default" },
      maxOutputTokens: 1024,
    }))
      events.push(event);
    expect(report(events).decisions[0].outcome).toBe("enabled");
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((event) => event.type === "cache_report")).toHaveLength(1);
  });

  it("uses refreshed catalog capability instead of stale model definitions", () => {
    expect(
      configuredToolConstraintCapability(
        { id: "model", compat: { supportsStrictMode: false } },
        [{ id: "model", supportsStrictMode: true, contextWindow: 32000, maxTokens: 1024 }],
        true,
      ),
    ).toEqual({ state: "unsupported", source: "catalog" });
  });

  it("includes intent in the existing cache fingerprint", () => {
    const fingerprinter = new ModelCacheFingerprinter();
    expect(fingerprinter.fingerprint(selection, request("prefer")).staticPrefixDigest).not.toBe(
      fingerprinter.fingerprint(selection, request("off")).staticPrefixDigest,
    );
  });
});
