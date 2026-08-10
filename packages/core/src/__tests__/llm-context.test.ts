import { describe, expect, it } from "vitest";
import { toContextMessages } from "../llm-context";
import type { AssistantAgentMessage } from "../models/messages";

describe("toContextMessages", () => {
  it("preserves provider routing metadata required by deferred responses", () => {
    const message: AssistantAgentMessage = {
      role: "assistant",
      content: [],
      api: "test-api",
      provider: "test-provider",
      model: "catalog-model",
      responseModel: "served-model",
      stopReason: "deferred",
      deferred: {
        provider: "test-provider",
        modelId: "catalog-model",
        api: "test-api",
        id: "job-1",
      },
      rawStopReason: "queued",
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      timestamp: 123,
    };

    expect(toContextMessages([message])[0]).toEqual(
      expect.objectContaining({
        responseModel: "served-model",
        deferred: expect.objectContaining({ id: "job-1" }),
        rawStopReason: "queued",
        timestamp: 0,
      }),
    );
  });
});
