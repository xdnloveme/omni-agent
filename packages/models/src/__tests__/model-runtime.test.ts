import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "../runtime/model-runtime";
import { VendorRegistry } from "../vendors/registry";
import { createProviderContribution } from "../vendors/provider-contribution";
import { defineVendor } from "../vendors/define-vendor";
import { compatibleConnection } from "../providers/factories/compatible";
import { transportConnection } from "../providers/factories/transport";
import type { CredentialStore, StoredCredential } from "../credentials/types";

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

describe("ModelRuntime", () => {
  it("maps backend events to the stable Omni model event stream", async () => {
    const faux = fauxProvider({ provider: "test-vendor", models: [{ id: "test-model" }] });
    faux.setResponses([fauxAssistantMessage("hello")]);
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
      {
        vendorId: "test",
        connectionId: "default",
        providerId: "test-vendor",
        modelId: "test-model",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
      },
      {
        systemPrompt: "test",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
    ))
      events.push(event);

    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "done" }));
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
      {
        vendorId: "deferred",
        connectionId: "default",
        providerId: "deferred-vendor",
        modelId: "deferred-model",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
      },
      { systemPrompt: "test", messages: [], tools: [] },
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
                  request.messages[0]?.role ?? "missing",
                  options.apiKey ?? "missing",
                );
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
      {
        vendorId: "custom-protocol",
        connectionId: "default",
        providerId: "custom-protocol",
        modelId: "custom-model",
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
      },
      {
        systemPrompt: "test",
        messages: [{ role: "user", content: "hi" }],
      },
      {
        credential: { type: "api_key", key: "request-key" },
      },
    ))
      events.push(event);

    expect(seen).toEqual(["custom-model", "user", "request-key"]);
    expect(events).toEqual([
      { type: "text_delta", delta: "custom" },
      expect.objectContaining({ type: "done" }),
    ]);
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
