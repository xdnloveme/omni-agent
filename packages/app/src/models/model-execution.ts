import { isDeepStrictEqual } from "node:util";
import {
  CacheAwareModelRuntime,
  DefaultModelCachePolicy,
  ModelExecutionClient,
  listenModelExecution,
  type ModelSelection,
} from "@omni-agent/models";
import type { AgentModelService, ModelService } from "./model-service";

export async function serveModelExecution(
  service: ModelService,
  selection: ModelSelection,
  path: string,
) {
  return listenModelExecution(path, await service.bindExecution(selection));
}

export async function connectModelExecution(
  path: string,
  signal?: AbortSignal,
): Promise<AgentModelService> {
  const client = await ModelExecutionClient.connect(path, signal);
  const { selection: bound, configuration, cacheCapability, credentialType } = client.descriptor;
  const runtime = new CacheAwareModelRuntime(
    client,
    new DefaultModelCachePolicy(),
    () => cacheCapability,
  );
  return {
    runtime,
    diagnostics: [],
    async resolve(selection) {
      if (
        selection.vendorId !== configuration.vendorId ||
        selection.connectionId !== configuration.connectionId ||
        selection.modelId !== configuration.modelId ||
        !isDeepStrictEqual(selection.settings ?? {}, configuration.settings ?? {}) ||
        selection.requestedOutputTokens !== configuration.requestedOutputTokens
      ) {
        throw new Error("Model configuration differs from the bound execution session");
      }
      return structuredClone(bound);
    },
    async isConfigured(providerId) {
      return providerId === bound.providerId ? { type: credentialType } : undefined;
    },
    async dispose() {
      runtime.clear();
      client.close();
    },
  };
}
