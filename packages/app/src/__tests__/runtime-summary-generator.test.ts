import { describe, expect, it, vi } from "vitest";
import type { ModelRuntimePort, RuntimeModelSelection } from "@omni-agent/core";
import { RuntimeContextSummaryGenerator } from "../context";

const selection: RuntimeModelSelection = {
  vendorId: "test",
  connectionId: "default",
  providerId: "test",
  modelId: "model",
  contextWindow: 10_000,
  modelMaxOutputTokens: 1_000,
  requestedOutputTokens: 1_000,
};

describe("RuntimeContextSummaryGenerator", () => {
  it("uses an auxiliary tool-free request with prompt caching disabled", async () => {
    const stream = vi.fn<ModelRuntimePort["stream"]>(() =>
      (async function* () {
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "<summary>result</summary>" }],
            api: "test",
            provider: "test",
            model: "model",
            stopReason: "stop" as const,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            timestamp: 1,
          },
        };
      })(),
    );
    const generator = new RuntimeContextSummaryGenerator({ stream }, () => selection);

    await generator.generate({
      agentId: "coding",
      sessionId: "session-1",
      systemPrompt: "system",
      userPrompt: "user",
      maxOutputTokens: 500,
      modelCallId: "summary-call",
    });

    expect(stream).toHaveBeenCalledWith(
      selection,
      { systemPrompt: "system", messages: [{ role: "user", content: "user" }], tools: [] },
      expect.objectContaining({
        identity: expect.objectContaining({ purpose: "auxiliary" }),
        cache: { retention: "none" },
        maxOutputTokens: 500,
      }),
    );
  });
});
