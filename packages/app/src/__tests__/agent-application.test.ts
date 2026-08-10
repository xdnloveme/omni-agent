import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, ModelRuntimePort } from "@omni-agent/core";
import { AgentApplication } from "../application/agent-application";
import type { ExtensionManager } from "../extensions/extension-manager";
import type { ModelService } from "../models/model-service";
import { SessionService } from "../sessions/session-service";

function fixture(
  ownsModelService: boolean,
  persistModelSelection?: ConstructorParameters<
    typeof AgentApplication
  >[0]["persistModelSelection"],
) {
  const runtime: ModelRuntimePort = {
    async *stream() {
      /* no events */
    },
  };
  const disposeExtensions = vi.fn(async () => undefined);
  const disposeModels = vi.fn(async () => undefined);
  const selection = { vendorId: "test", connectionId: "default", modelId: "model" };
  const resolveModel = vi.fn<ModelService["resolve"]>(async (nextSelection) => ({
    ...nextSelection,
    providerId: nextSelection.vendorId,
    contextWindow: 2_000,
    maxOutputTokens: 200,
  }));
  const isConfigured = vi.fn<ModelService["isConfigured"]>(async () => ({ type: "api_key" }));
  const extensions = { dispose: disposeExtensions } as unknown as ExtensionManager;
  const modelService = {
    runtime,
    dispose: disposeModels,
    resolve: resolveModel,
    isConfigured,
  } as unknown as ModelService;
  const config: AgentConfig = {
    model: {
      ...selection,
      providerId: "test",
      contextWindow: 1_000,
      maxOutputTokens: 100,
    },
    systemPrompt: "test",
    tools: [],
  };
  return {
    app: new AgentApplication({
      extensions,
      sessions: new SessionService(),
      agentConfig: config,
      agentId: "test",
      cwd: process.cwd(),
      modelService,
      modelSelection: selection,
      persistModelSelection,
      ownsModelService,
    }),
    disposeExtensions,
    disposeModels,
    isConfigured,
    resolveModel,
  };
}

describe("AgentApplication model service ownership", () => {
  it("does not dispose an injected model service", async () => {
    const { app, disposeExtensions, disposeModels } = fixture(false);
    await app.dispose();
    expect(disposeExtensions).toHaveBeenCalledOnce();
    expect(disposeModels).not.toHaveBeenCalled();
  });

  it("disposes a model service created for the application", async () => {
    const { app, disposeModels } = fixture(true);
    await app.dispose();
    expect(disposeModels).toHaveBeenCalledOnce();
  });

  it("disposes its model service even when extension cleanup fails", async () => {
    const { app, disposeExtensions, disposeModels } = fixture(true);
    disposeExtensions.mockRejectedValueOnce(new Error("extension cleanup failed"));
    await expect(app.dispose()).rejects.toThrow("extension cleanup failed");
    expect(disposeModels).toHaveBeenCalledOnce();
  });

  it("switches model only after resolution, authentication, and persistence succeed", async () => {
    const persist = vi.fn(async () => undefined);
    const { app } = fixture(false, persist);
    const next = { vendorId: "next", connectionId: "regional", modelId: "next-model" };

    await app.setModel(next);

    expect(persist).toHaveBeenCalledWith(next);
    expect(app.modelSelection).toEqual(next);
    expect(app.agentConfig.model).toEqual(
      expect.objectContaining({ providerId: "next", modelId: "next-model" }),
    );
  });

  it("keeps the active model unchanged when authentication fails", async () => {
    const persist = vi.fn(async () => undefined);
    const { app, isConfigured } = fixture(false, persist);
    isConfigured.mockResolvedValueOnce(undefined);
    const previousSelection = app.modelSelection;
    const previousModel = app.agentConfig.model;

    await expect(
      app.setModel({ vendorId: "next", connectionId: "default", modelId: "next-model" }),
    ).rejects.toThrow("Provider is not configured");

    expect(persist).not.toHaveBeenCalled();
    expect(app.modelSelection).toBe(previousSelection);
    expect(app.agentConfig.model).toBe(previousModel);
  });

  it("keeps the active model unchanged when atomic persistence fails", async () => {
    const persist = vi.fn(async () => {
      throw new Error("config write failed");
    });
    const { app } = fixture(false, persist);
    const previousSelection = app.modelSelection;
    const previousModel = app.agentConfig.model;

    await expect(
      app.setModel({ vendorId: "next", connectionId: "default", modelId: "next-model" }),
    ).rejects.toThrow("config write failed");

    expect(app.modelSelection).toBe(previousSelection);
    expect(app.agentConfig.model).toBe(previousModel);
  });
});
