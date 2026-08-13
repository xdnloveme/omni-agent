import { describe, expect, it, vi } from "vitest";
import type { TranscriptMessage } from "../messages";
import {
  ApproximateContextTokenEstimator,
  ArtifactProjectionStrategy,
  ContextPolicyPipeline,
  HeavyCheckpointGateStage,
  SkillProjectionStrategy,
  StableMicroCompressionStage,
  ThinkingProjectionStrategy,
  microCompressionThreshold,
  shouldAdvanceMicroCompression,
  type ContextCheckpoint,
  type ContextCheckpointStorePort,
  type ContextFinalGateOptions,
  type ContextFinalGatePort,
  type ContextEntry,
  type ContextProjectionState,
  type ContextProjectionStorePort,
  type ContextRewriteGuardPort,
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

  it("uses the dynamic warning buffer and triggers only above the threshold", () => {
    const ordinary = {
      systemPromptTokens: 0,
      messageTokens: 59_001,
      toolTokens: 0,
      totalInputTokens: 59_001,
      usableInputBudget: 99_000,
      usageRatio: 59_001 / 99_000,
    };
    expect(microCompressionThreshold(ordinary)).toBe(59_000);
    expect(shouldAdvanceMicroCompression(ordinary)).toBe(true);
    expect(shouldAdvanceMicroCompression({ ...ordinary, totalInputTokens: 59_000 })).toBe(false);
    expect(microCompressionThreshold({ ...ordinary, usableInputBudget: 600_000 })).toBe(300_000);
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
    const projections = projectionStore();
    const checkpoints: ContextCheckpointStorePort = {
      async list() {
        return [];
      },
      append: vi.fn(),
    };
    const summaries: ContextSummaryGeneratorPort = { generate: vi.fn() };
    const pipeline = new ContextPolicyPipeline(
      [stableMicro(projections, estimator)],
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
    expect(projections.commit).not.toHaveBeenCalled();
    expect(summaries.generate).not.toHaveBeenCalled();
  });

  it("always reaches the Heavy final gate when the Micro rewrite guard defers", async () => {
    const estimator = new ApproximateContextTokenEstimator();
    const projections = projectionStore();
    const checkpoints: ContextCheckpointStorePort = {
      async list() {
        return [];
      },
      append: vi.fn(),
    };
    const generate = vi.fn<ContextSummaryGeneratorPort["generate"]>(async () => ({
      summary: "checkpoint summary",
      provider: "test",
      model: "model",
    }));
    const messages: TranscriptMessage[] = Array.from({ length: 5 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "grep",
      content: [{ type: "text", text: "x".repeat(90_000) }],
      isError: false,
      timestamp: index,
    }));
    const source = frame(messages, 100_000);
    const pipeline = new ContextPolicyPipeline(
      [
        stableMicro(projections, estimator, {
          assess: () => ({ action: "defer", reason: "active" }),
        }),
      ],
      new HeavyCheckpointGateStage(checkpoints, { generate }, estimator),
      estimator,
    );

    const result = await pipeline.resolve(source, {
      agentId: "coding",
      sessionId: "session-1",
      sessionRevision: 1,
      modelCallId: "call-1",
      middlewareDigest: "middleware",
      sourceMessages: messages,
    });

    expect(generate).toHaveBeenCalled();
    expect(result.frame.entries[0]).toMatchObject({ kind: "checkpoint" });
  });
});

describe("StableMicroCompressionStage", () => {
  it("projects old large text results, preserves the latest three, and commits once", async () => {
    const projections = projectionStore();
    const messages: TranscriptMessage[] = Array.from({ length: 5 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "grep",
      content: [{ type: "text", text: String(index).repeat(60_000) }],
      isError: false,
      timestamp: index,
    }));
    const source = frame(messages, 100_000);
    const estimator = new ApproximateContextTokenEstimator();
    const result = await stableMicro(projections, estimator).apply(
      source,
      gateOptions(estimator, source),
    );

    expect(projections.commit).toHaveBeenCalledOnce();
    expect(projections.artifacts).toHaveLength(2);
    expect(result.frame.entries.map((entry) => entry.kind)).toEqual([
      "toolResultArtifact",
      "toolResultArtifact",
      "transcript",
      "transcript",
      "transcript",
    ]);
    const replayed = await stableMicro(projections, estimator).apply(
      source,
      gateOptions(estimator, source),
    );
    expect(replayed.frame).toEqual(result.frame);
    expect(projections.commit).toHaveBeenCalledOnce();

    projections.artifacts.splice(0);
    const rebuilt = await stableMicro(projections, estimator).apply(
      source,
      gateOptions(estimator, source),
    );
    expect(
      rebuilt.frame.entries.slice(0, 2).every((entry) => entry.kind === "toolResultArtifact"),
    ).toBe(true);
    expect(projections.commit).toHaveBeenCalledTimes(2);
  });

  it("does not commit when an active rewrite guard defers projection", async () => {
    const projections = projectionStore();
    const messages: TranscriptMessage[] = Array.from({ length: 5 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "grep",
      content: [{ type: "text", text: "x".repeat(60_000) }],
      isError: false,
      timestamp: index,
    }));
    const source = frame(messages, 100_000);
    const estimator = new ApproximateContextTokenEstimator();
    const stage = stableMicro(projections, estimator, {
      assess: () => ({ action: "defer", reason: "active", reconsiderAt: 10 }),
    });
    const result = await stage.apply(source, gateOptions(estimator, source));

    expect(projections.commit).not.toHaveBeenCalled();
    expect(result.decisions[0]).toMatchObject({ type: "stable_micro_deferred" });
  });

  it("projects structured Skill results without treating them as generic artifacts", async () => {
    const projections = projectionStore();
    const messages: TranscriptMessage[] = Array.from({ length: 5 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `skill-${index}`,
      toolName: "skill_read",
      content: [{ type: "text", text: `skill ${index} ${"x".repeat(60_000)}` }],
      details: { kind: "skill_read", skillName: `skill-${index}` },
      isError: false,
      timestamp: index,
    }));
    const source = frame(messages, 100_000);
    const estimator = new ApproximateContextTokenEstimator();
    const stage = new StableMicroCompressionStage({
      projections,
      estimator,
      rewriteGuard: { assess: () => ({ action: "allow", reason: "test" }) },
      strategies: [
        new ArtifactProjectionStrategy(projections, undefined, ["skill_read"]),
        new SkillProjectionStrategy({ resultKind: "skill_read", toolName: "skill_read" }),
        new ThinkingProjectionStrategy(() => "preserve_all"),
      ],
    });

    const result = await stage.apply(source, gateOptions(estimator, source));
    expect(result.frame.entries.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "transcript",
          message: expect.objectContaining({
            content: [expect.objectContaining({ text: expect.stringContaining("skill_read") })],
          }),
        }),
      ]),
    );
    expect(projections.artifacts).toEqual([]);
  });

  it("clears only old Thinking text when the model capability explicitly allows it", async () => {
    let thinkingPolicy: "clear_old_text" | "preserve_all" = "clear_old_text";
    const projections = projectionStore();
    const messages: TranscriptMessage[] = Array.from({ length: 5 }, (_, index) => ({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: `${index}:${"x".repeat(60_000)}`,
          thinkingSignature: `signature-${index}`,
        },
        { type: "text", text: `answer-${index}` },
      ],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      timestamp: index,
    }));
    const source = frame(messages, 100_000);
    const estimator = new ApproximateContextTokenEstimator();
    const stage = new StableMicroCompressionStage({
      projections,
      estimator,
      rewriteGuard: { assess: () => ({ action: "allow", reason: "test" }) },
      strategies: [
        new ArtifactProjectionStrategy(projections, undefined),
        new ThinkingProjectionStrategy(() => thinkingPolicy),
      ],
    });
    const clearingDigest = stage.configurationDigest();

    const result = await stage.apply(source, gateOptions(estimator, source));
    const assistantEntries = result.frame.entries.filter(
      (entry): entry is Extract<ContextEntry, { kind: "transcript" }> =>
        entry.kind === "transcript" && entry.message.role === "assistant",
    );
    expect(assistantEntries[0]?.message.content[0]).toMatchObject({
      type: "thinking",
      thinking: "",
      thinkingSignature: "signature-0",
    });
    expect(assistantEntries[1]?.message.content[0]).toMatchObject({ thinking: "" });
    expect(
      assistantEntries.slice(-3).every((entry) => {
        const block = entry.message.content[0];
        return typeof block !== "string" && block?.type === "thinking" && block.thinking.length > 0;
      }),
    ).toBe(true);

    thinkingPolicy = "preserve_all";
    expect(stage.configurationDigest()).not.toBe(clearingDigest);
    const preserved = await stage.apply(source, gateOptions(estimator, source));
    expect(preserved.frame.entries).toEqual(source.entries);
  });
});

function stableMicro(
  projections: ReturnType<typeof projectionStore>,
  estimator: ApproximateContextTokenEstimator,
  rewriteGuard: ContextRewriteGuardPort = {
    assess: () => ({ action: "allow", reason: "test" }),
  },
) {
  return new StableMicroCompressionStage({
    projections,
    estimator,
    rewriteGuard,
    strategies: [
      new ArtifactProjectionStrategy(projections, {
        toolName: "file_read",
        instruction: "Read the artifact when needed.",
      }),
      new ThinkingProjectionStrategy(() => "preserve_all"),
    ],
  });
}

function projectionStore() {
  let state: ContextProjectionState | undefined;
  const artifacts: Array<{ artifactId: string; content: string; contentDigest: string }> = [];
  const store: ContextProjectionStorePort & {
    artifacts: typeof artifacts;
    commit: ReturnType<typeof vi.fn<ContextProjectionStorePort["commit"]>>;
  } = {
    artifacts,
    async load() {
      return state;
    },
    artifactPath(_sessionId, artifactId) {
      return `/artifacts/${artifactId}.txt`;
    },
    async artifactMatches(_sessionId, artifactId, contentDigest) {
      return artifacts.some(
        (artifact) =>
          artifact.artifactId === artifactId && artifact.contentDigest === contentDigest,
      );
    },
    commit: vi.fn<ContextProjectionStorePort["commit"]>(async (input) => {
      artifacts.push(...input.artifacts.map((artifact) => ({ ...artifact })));
      state = structuredClone(input.nextState);
    }),
  };
  return store;
}

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
