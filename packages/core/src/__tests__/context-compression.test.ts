import { describe, expect, it, vi } from "vitest";
import type { TranscriptMessage } from "../messages";
import {
  ApproximateContextTokenEstimator,
  ContextPolicyPipeline,
  HeavyCheckpointGateStage,
  ToolResultMicroStage,
  type ContextArtifactStorePort,
  type ContextCheckpoint,
  type ContextCheckpointStorePort,
  type ContextFinalGateOptions,
  type ContextFinalGatePort,
  type ContextSummaryGeneratorPort,
} from "../context";
import { createContextFrame } from "../context/policy/types";

function gateOptions(
  estimator: ApproximateContextTokenEstimator,
  frame: ReturnType<typeof createContextFrame>,
): ContextFinalGateOptions {
  return {
    agentId: "coding",
    sessionId: "session-1",
    sessionRevision: 3,
    modelCallId: "call-1",
    middlewareDigest: "middleware",
    sourceMessages: frame.entries
      .filter((entry) => entry.kind === "transcript")
      .map((entry) => entry.message),
    precedingStages: [],
    estimate: estimator.estimate(frame),
  };
}

function finalGate(order?: string[]): ContextFinalGatePort {
  return {
    name: "test_final_gate",
    version: 1,
    async apply(input) {
      order?.push("final");
      return { frame: structuredClone(input) as never, decisions: [] };
    },
  };
}

function frame(messages: TranscriptMessage[], contextWindow = 600) {
  return createContextFrame({
    systemPrompt: "system",
    messages,
    tools: [],
    model: { modelId: "model", contextWindow, maxOutputTokens: 100 },
  });
}

describe("Context policy pipeline", () => {
  it("preserves the existing aggregate token-estimation formula", () => {
    const estimator = new ApproximateContextTokenEstimator();
    const source = createContextFrame({
      systemPrompt: "a",
      messages: [{ role: "user", content: "b", timestamp: 1 }],
      tools: [],
      model: { modelId: "model", contextWindow: 100, maxOutputTokens: 10 },
    });

    expect(estimator.estimate(source).totalInputTokens).toBe(1);
  });

  it("runs business-independent stages serially with detached frames", async () => {
    const estimator = new ApproximateContextTokenEstimator();
    const order: string[] = [];
    let receivedOptions: object | undefined;
    const pipeline = new ContextPolicyPipeline(
      [
        {
          name: "first",
          version: 1,
          async apply(input, options) {
            order.push("first");
            receivedOptions = options;
            return { frame: structuredClone(input) as never, decisions: [{ type: "first" }] };
          },
        },
        {
          name: "second",
          version: 1,
          async apply(input) {
            order.push("second");
            return { frame: structuredClone(input) as never, decisions: [{ type: "second" }] };
          },
        },
      ],
      finalGate(order),
      estimator,
    );
    const source = frame([{ role: "user", content: "hello", timestamp: 1 }]);
    const result = await pipeline.resolve(source, {
      agentId: "coding",
      sessionId: "session-1",
      sessionRevision: 1,
      modelCallId: "call-1",
      middlewareDigest: "middleware",
      sourceMessages: [{ role: "user", content: "hello", timestamp: 1 }],
    });

    expect(order).toEqual(["first", "second", "final"]);
    expect(result.decisions.map((decision) => decision.type)).toEqual(["first", "second"]);
    expect(result.frame).not.toBe(source);
    expect(result.stages).toHaveLength(3);
    expect(Object.keys(receivedOptions!).sort()).toEqual([
      "agentId",
      "estimate",
      "modelCallId",
      "sessionId",
      "signal",
    ]);
  });

  it("keeps full history unchanged when built-in thresholds are not reached", async () => {
    const estimator = new ApproximateContextTokenEstimator();
    const artifacts: ContextArtifactStorePort = {
      write: vi.fn(),
    };
    const checkpoints: ContextCheckpointStorePort = {
      async list() {
        return [];
      },
      append: vi.fn(),
    };
    const summaries: ContextSummaryGeneratorPort = { generate: vi.fn() };
    const pipeline = new ContextPolicyPipeline(
      [new ToolResultMicroStage(artifacts)],
      new HeavyCheckpointGateStage(checkpoints, summaries, estimator),
      estimator,
    );
    const sourceMessages: TranscriptMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];
    const source = frame(sourceMessages, 10_000);
    const result = await pipeline.resolve(source, {
      agentId: "coding",
      sessionId: "session-1",
      sessionRevision: 1,
      modelCallId: "call-1",
      middlewareDigest: "middleware",
      sourceMessages,
    });

    expect(result.frame.entries).toEqual(source.entries);
    expect(artifacts.write).not.toHaveBeenCalled();
    expect(summaries.generate).not.toHaveBeenCalled();
  });
});

describe("ToolResultMicroStage", () => {
  it("externalizes old large text results and preserves the latest three", async () => {
    const writes: Array<{ artifactId: string; content: string }> = [];
    const artifacts: ContextArtifactStorePort = {
      async write(request) {
        writes.push(request);
        return `/artifacts/${request.artifactId}.txt`;
      },
    };
    const messages: TranscriptMessage[] = Array.from({ length: 5 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "grep",
      content: [{ type: "text", text: String(index).repeat(800) }],
      isError: false,
      timestamp: index,
    }));
    const source = frame(messages, 1_000);
    const estimator = new ApproximateContextTokenEstimator();
    const result = await new ToolResultMicroStage(artifacts).apply(
      source,
      gateOptions(estimator, source),
    );

    expect(writes).toHaveLength(2);
    expect(result.frame.entries.map((entry) => entry.kind)).toEqual([
      "toolResultArtifact",
      "toolResultArtifact",
      "transcript",
      "transcript",
      "transcript",
    ]);
  });

  it("fails preparation when an artifact cannot be persisted", async () => {
    const artifacts: ContextArtifactStorePort = {
      async write() {
        throw new Error("artifact unavailable");
      },
    };
    const messages: TranscriptMessage[] = Array.from({ length: 5 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "grep",
      content: [{ type: "text", text: "x".repeat(800) }],
      isError: false,
      timestamp: index,
    }));
    const source = frame(messages, 1_000);
    const estimator = new ApproximateContextTokenEstimator();

    await expect(
      new ToolResultMicroStage(artifacts).apply(source, gateOptions(estimator, source)),
    ).rejects.toThrow("artifact unavailable");
  });
});

describe("HeavyCheckpointGateStage", () => {
  it("creates a persisted checkpoint and reuses it on the next preparation", async () => {
    const checkpoints: ContextCheckpoint[] = [];
    const store: ContextCheckpointStorePort = {
      async list() {
        return checkpoints;
      },
      async append(checkpoint) {
        checkpoints.push(checkpoint);
      },
    };
    const generate = vi.fn<ContextSummaryGeneratorPort["generate"]>(async () => ({
      summary: "checkpoint summary".repeat(5),
      provider: "test",
      model: "model",
    }));
    const estimator = new ApproximateContextTokenEstimator();
    const source = frame(
      Array.from({ length: 4 }, (_, index) => ({
        role: "user" as const,
        content: `${index}:${"x".repeat(1_000)}`,
        timestamp: index,
      })),
    );
    const stage = new HeavyCheckpointGateStage(store, { generate }, estimator);

    const first = await stage.apply(source, gateOptions(estimator, source));
    const second = await stage.apply(source, gateOptions(estimator, source));

    expect(generate).toHaveBeenCalledOnce();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].coveredMessageCount).toBe(4);
    expect(first.frame.entries[0]).toMatchObject({ kind: "checkpoint" });
    expect(second.decisions[0]).toMatchObject({ type: "checkpoint_reused" });
    expect(estimator.estimate(first.frame).usageRatio).toBeLessThanOrEqual(0.5);
  });

  it("retries summary generation once and never falls back to full history", async () => {
    const store: ContextCheckpointStorePort = {
      async list() {
        return [];
      },
      append: vi.fn(),
    };
    const generate = vi.fn<ContextSummaryGeneratorPort["generate"]>(async () => {
      throw new Error("summary unavailable");
    });
    const estimator = new ApproximateContextTokenEstimator();
    const source = frame([{ role: "user", content: "x".repeat(5_000), timestamp: 1 }]);

    await expect(
      new HeavyCheckpointGateStage(store, { generate }, estimator).apply(
        source,
        gateOptions(estimator, source),
      ),
    ).rejects.toThrow("after two attempts");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(store.append).not.toHaveBeenCalled();
  });
});
