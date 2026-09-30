import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { ModelRuntime } from "../runtime/model-runtime";
import { VendorRegistry } from "../vendors/registry";
import { createProviderContribution } from "../vendors/provider-contribution";
import { defineVendor } from "../vendors/define-vendor";
import { compatibleConnection } from "../providers/factories/compatible";
import { transportConnection } from "../providers/factories/transport";
import type { CredentialStore, StoredCredential } from "../credentials/types";
import type { ModelTransportExecutionOptions } from "../cache/contracts";
import type { RuntimeModelSelection } from "@omni-agent/core";

function executionOptions(
  overrides: Partial<ModelTransportExecutionOptions> = {},
): ModelTransportExecutionOptions {
  return {
    providerCache: { cacheRetention: "none" },
    maxOutputTokens: 4_096,
    ...overrides,
  };
}

function modelSelection(
  vendorId: string,
  providerId: string,
  modelId: string,
  contextWindow = 32_000,
  maxOutputTokens = 4_096,
): RuntimeModelSelection {
  return {
    vendorId,
    connectionId: "default",
    providerId,
    modelId,
    contextWindow,
    modelMaxOutputTokens: maxOutputTokens,
    requestedOutputTokens: maxOutputTokens,
  };
}

function openAiSseResponse(): Response {
  return new Response(
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"wire-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11,"prompt_tokens_details":{"cached_tokens":5}}}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Exhaust the stream.
  }
}

function memoryCredentials(): CredentialStore {
  const values = new Map<string, StoredCredential>();
  return {
    read: async (providerId) => values.get(providerId) ?? { type: "api_key", key: "test-key" },
    list: async () => [],
    modify: async (providerId, fn) => {
      const next = await fn(values.get(providerId));
      if (next) values.set(providerId, next);
      return next;
    },
    delete: async (providerId) => {
      values.delete(providerId);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelRuntime", () => {
  it("maps backend events to the stable Omni model event stream", async () => {
    const faux = fauxProvider({ provider: "test-vendor", models: [{ id: "test-model" }] });
    let seenMaxTokens: number | undefined;
    let seenCacheRetention: string | undefined;
    let seenSessionId: string | undefined;
    faux.setResponses([
      (_context, options) => {
        seenMaxTokens = options?.maxTokens;
        seenCacheRetention = options?.cacheRetention;
        seenSessionId = options?.sessionId;
        return fauxAssistantMessage([fauxThinking("checking"), fauxText("hello")]);
      },
    ]);
    const runtime = new ModelRuntime({ credentials: memoryCredentials() });
    const manager = runtime.createPluginManager(new VendorRegistry());
    await manager.register({
      manifest: { id: "test", version: "1.0.0", apiVersion: 1 },
      vendor: {
        id: "test",
        displayName: "Test",
        connections: [{ id: "default", displayName: "Default", providerId: "test-vendor" }],
      },
      createProviders: () => [createProviderContribution(faux.provider)],
    });
    expect(runtime.getAuthMethods("test-vendor")).toEqual([
      expect.objectContaining({ type: "api_key" }),
    ]);
    const events = [];
    for await (const event of runtime.stream(
      modelSelection("test", "test-vendor", "test-model", 128_000),
      {
        systemPrompt: "test",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
      executionOptions({
        maxOutputTokens: 512,
        providerCache: { cacheRetention: "short", sessionId: "cache-scope" },
      }),
    ))
      events.push(event);

    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["thinking_start", "thinking_delta", "thinking_end"]),
    );
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "done" }));
    expect(seenMaxTokens).toBe(512);
    expect(seenCacheRetention).toBe("short");
    expect(seenSessionId).toBe("cache-scope");
    await manager.dispose();
  });

  it("preserves deferred response metadata without exposing backend message types", async () => {
    const faux = fauxProvider({ provider: "deferred-vendor", models: [{ id: "deferred-model" }] });
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "deferred",
        deferred: {
          provider: "deferred-vendor",
          modelId: "deferred-model",
          api: "faux",
          id: "job-1",
        },
      }),
    ]);
    const runtime = new ModelRuntime({ credentials: memoryCredentials() });
    const manager = runtime.createPluginManager(new VendorRegistry());
    await manager.register({
      manifest: { id: "deferred", version: "1.0.0", apiVersion: 1 },
      vendor: {
        id: "deferred",
        displayName: "Deferred",
        connections: [{ id: "default", displayName: "Default", providerId: "deferred-vendor" }],
      },
      createProviders: () => [createProviderContribution(faux.provider)],
    });
    const events = [];
    for await (const event of runtime.stream(
      modelSelection("deferred", "deferred-vendor", "deferred-model", 128_000),
      { systemPrompt: "test", messages: [], tools: [] },
      executionOptions(),
    ))
      events.push(event);

    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "done",
        message: expect.objectContaining({ deferred: expect.objectContaining({ id: "job-1" }) }),
      }),
    );
    await manager.dispose();
  });

  it("runs a new wire protocol through the backend-neutral ModelTransport port", async () => {
    const runtime = new ModelRuntime({ credentials: memoryCredentials() });
    const manager = runtime.createPluginManager(new VendorRegistry());
    const seen: string[] = [];
    await manager.register(
      defineVendor({
        id: "custom-protocol",
        displayName: "Custom Protocol",
        connections: [
          transportConnection({
            id: "default",
            displayName: "Custom Protocol",
            providerId: "custom-protocol",
            providerName: "Custom Protocol",
            baseUrl: "https://models.example.com",
            envVars: ["CUSTOM_PROTOCOL_API_KEY"],
            models: [{ id: "custom-model", contextWindow: 32_000, maxTokens: 4_096 }],
            transport: {
              async *stream(model, request, options) {
                seen.push(
                  model.id,
                  String(model.requestedOutputTokens),
                  request.messages[0]?.role ?? "missing",
                  options.apiKey ?? "missing",
                );
                yield { type: "thinking_start", contentIndex: 0 };
                yield { type: "thinking_delta", contentIndex: 0, delta: "checking" };
                yield { type: "thinking_end", contentIndex: 0, content: "checking" };
                yield { type: "text_delta", delta: "custom" };
                yield {
                  type: "done",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "custom" }],
                    api: "custom-protocol",
                    provider: model.providerId,
                    model: model.id,
                    stopReason: "stop",
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                    timestamp: Date.now(),
                  },
                };
              },
            },
          }),
        ],
      }),
    );

    const events = [];
    for await (const event of runtime.stream(
      modelSelection("custom-protocol", "custom-protocol", "custom-model"),
      {
        systemPrompt: "test",
        messages: [{ role: "user", content: "hi" }],
      },
      executionOptions({
        credential: { type: "api_key", key: "request-key" },
        maxOutputTokens: 512,
      }),
    ))
      events.push(event);

    expect(seen).toEqual(["custom-model", "512", "user", "request-key"]);
    expect(events).toEqual([
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "checking" },
      { type: "thinking_end", contentIndex: 0, content: "checking" },
      { type: "text_delta", delta: "custom" },
      expect.objectContaining({ type: "done" }),
    ]);
    await manager.dispose();
  });

  it("normalizes completed text that a transport did not stream", async () => {
    const runtime = new ModelRuntime({ credentials: memoryCredentials() });
    const manager = runtime.createPluginManager(new VendorRegistry());
    await manager.register(
      defineVendor({
        id: "terminal-text",
        displayName: "Terminal Text",
        connections: [
          transportConnection({
            id: "default",
            displayName: "Terminal Text",
            providerId: "terminal-text",
            providerName: "Terminal Text",
            baseUrl: "https://models.example.com",
            envVars: ["TERMINAL_TEXT_API_KEY"],
            models: [{ id: "terminal-model", contextWindow: 32_000, maxTokens: 4_096 }],
            transport: {
              async *stream(model) {
                yield {
                  type: "done",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "complete response" }],
                    api: "terminal-text",
                    provider: model.providerId,
                    model: model.id,
                    stopReason: "stop",
                    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                    timestamp: Date.now(),
                  },
                };
              },
            },
          }),
        ],
      }),
    );

    const events = [];
    for await (const event of runtime.stream(
      modelSelection("terminal-text", "terminal-text", "terminal-model"),
      { systemPrompt: "test", messages: [] },
      executionOptions(),
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", delta: "complete response" },
      expect.objectContaining({ type: "done" }),
    ]);
    await manager.dispose();
  });

  it("delegates stable cache keys and message prefixes to pi-ai wire serialization", async () => {
    const payloads: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => openAiSseResponse()),
    );
    const runtime = new ModelRuntime({
      credentials: memoryCredentials(),
      onPayload: (payload) => {
        payloads.push(payload);
      },
    });
    const manager = runtime.createPluginManager(new VendorRegistry());
    await manager.register(
      defineVendor({
        id: "wire",
        displayName: "Wire",
        connections: [
          compatibleConnection({
            id: "default",
            displayName: "Wire",
            providerId: "wire",
            providerName: "Wire",
            baseUrl: "https://wire.example.com/v1",
            envVars: ["WIRE_API_KEY"],
            protocol: "openai-completions",
            compat: { supportsLongCacheRetention: true },
            models: [{ id: "wire-model", contextWindow: 32_000, maxTokens: 1_024 }],
          }),
        ],
      }),
    );
    const selection = modelSelection("wire", "wire", "wire-model", 32_000, 1_024);
    const firstMessage = { role: "user" as const, content: "hello" };
    const options = executionOptions({
      maxOutputTokens: 1_024,
      providerCache: { cacheRetention: "long", sessionId: "stable-scope" },
    });

    await drain(
      runtime.stream(selection, { systemPrompt: "system", messages: [firstMessage] }, options),
    );
    await drain(
      runtime.stream(
        selection,
        {
          systemPrompt: "system",
          messages: [firstMessage, { role: "user", content: "next" }],
        },
        options,
      ),
    );

    const [first, resumed] = payloads as Array<{
      max_tokens?: number;
      max_completion_tokens?: number;
      prompt_cache_key?: string;
      prompt_cache_retention?: string;
      messages?: unknown[];
    }>;
    expect(first.max_tokens ?? first.max_completion_tokens).toBe(1_024);
    await expect(
      drain(
        runtime.stream(
          selection,
          { systemPrompt: "system", messages: [firstMessage] },
          { ...options, maxOutputTokens: 2_048 },
        ),
      ),
    ).rejects.toThrow("Invalid prepared model output budget");
    expect(payloads).toHaveLength(2);
    expect(first.prompt_cache_key).toBe("stable-scope");
    expect(resumed.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(first.prompt_cache_retention).toBe("24h");
    expect(resumed.messages?.slice(0, first.messages?.length)).toEqual(first.messages);
    await manager.dispose();
  });

  it("refreshes and persists a dynamic provider catalog through the stable vendor API", async () => {
    const catalogDirectory = mkdtempSync(join(tmpdir(), "omni-model-catalog-"));
    try {
      const seen: Array<{ force?: boolean; credentialType?: string }> = [];
      const runtime = new ModelRuntime({
        credentials: memoryCredentials(),
        catalogDirectory,
      });
      const manager = runtime.createPluginManager(new VendorRegistry());
      await manager.register(
        defineVendor({
          id: "dynamic-provider",
          displayName: "Dynamic Provider",
          connections: [
            compatibleConnection({
              id: "default",
              displayName: "Dynamic Provider",
              providerId: "dynamic-provider",
              providerName: "Dynamic Provider",
              baseUrl: "https://models.example.com/v1",
              envVars: ["DYNAMIC_PROVIDER_API_KEY"],
              protocol: "openai-completions",
              models: [],
              async fetchModels(context) {
                seen.push({
                  force: context.force,
                  credentialType: context.credential?.type,
                });
                expect(context.signal.aborted).toBe(false);
                return [{ id: "dynamic-model", contextWindow: 64_000, maxTokens: 8_192 }];
              },
            }),
          ],
        }),
      );

      const aborted = new AbortController();
      aborted.abort();
      await runtime.refreshProvider("dynamic-provider", { signal: aborted.signal });
      expect(seen).toEqual([]);

      await runtime.refreshProvider("dynamic-provider", { force: true });
      expect(seen).toEqual([{ force: true, credentialType: "api_key" }]);
      expect(runtime.listModels("dynamic-provider")).toEqual([
        expect.objectContaining({ id: "dynamic-model", contextWindow: 64_000 }),
      ]);
      expect(readdirSync(catalogDirectory)).toHaveLength(1);
      await manager.dispose();
    } finally {
      rmSync(catalogDirectory, { recursive: true, force: true });
    }
  });
});
