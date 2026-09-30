import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenModelExecution } from "@omni-agent/models";
import { connectModelExecution } from "../models/model-execution";

it("compares the bound configuration before provider normalization, without reimplementing defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "ms-"));
  const path = join(root, "s");
  const configuration = {
    vendorId: "vendor",
    connectionId: "connection",
    modelId: "alias",
    settings: { temperature: 0.2 },
  };
  const resolved = {
    ...configuration,
    providerId: "provider",
    modelId: "resolved-model",
    settings: { temperature: 0.2, thinking: true },
    contextWindow: 10000,
    modelMaxOutputTokens: 1000,
    requestedOutputTokens: 1000,
  };
  const server = await listenModelExecution(path, {
    configuration,
    selection: resolved,
    credentialType: "api_key",
    cacheCapability: { mode: "none", retentions: ["none"], stableScopeRetentions: [] },
    transport: {
      async *stream() {
        throw new Error("Selection must not call the Provider");
      },
    },
  });
  try {
    const service = await connectModelExecution(path);
    try {
      expect(await service.resolve(configuration)).toEqual(resolved);
      await expect(service.resolve({ ...configuration, settings: {} })).rejects.toThrow("differs");
      await expect(
        service.resolve({ ...configuration, requestedOutputTokens: 500 }),
      ).rejects.toThrow("differs");
      expect(service.administration).toBeUndefined();
    } finally {
      await service.dispose();
    }
    await server.closed;
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
