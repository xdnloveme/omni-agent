import { describe, expect, it } from "vitest";
import {
  type ReplayEventInput,
  type ReplaySinkPort,
  type SpanPort,
  type TraceAttributes,
  type TraceRunIdentity,
  type TraceStatus,
  type TracerPort,
} from "../index";
import { CompositeRuntimeObserver } from "../runtime-observation";
import type { PreparedModelContext } from "../context";
import type { AssistantTranscriptMessage } from "../messages";
import type { RuntimeModelSelection } from "../models";
import { ReplayRuntimeObserver } from "../tracing/runtime-observer/replay-runtime-observer";
import { createRuntimeTraceObservers } from "../tracing/runtime-observer";

interface RecordedSpan {
  readonly name: string;
  readonly parent?: string;
  readonly attributes: Record<string, string | number | boolean>;
  status: TraceStatus;
  ended: number;
}

describe("Runtime Trace observers", () => {
  it("maps typed facts to the compatible Span tree and Replay sequence", () => {
    const spans: RecordedSpan[] = [];
    const replay: ReplayEventInput[] = [];
    let active: string | undefined;
    const tracer: TracerPort = {
      startSpan(name, attributes = {}) {
        const id = `span-${spans.length + 1}`;
        const span: RecordedSpan = {
          name,
          parent: active,
          attributes: { ...attributes },
          status: "unset",
          ended: 0,
        };
        spans.push(span);
        return spanPort(
          id,
          span,
          () => active,
          (value) => {
            active = value;
          },
        );
      },
    };
    const replaySink: ReplaySinkPort = { record: (event) => replay.push(event) };
    const observer = new CompositeRuntimeObserver(createRuntimeTraceObservers(tracer, replaySink));
    const run = observer.startRun({ agentId: "test", sessionId: "session", runId: "run" });
    run.userInput({ input: "hello" });
    const turn = run.run(() => run.startTurn({ turn: 0 }));
    const context = turn.run(() => turn.startContext({ turn: 0 }));
    const prepared = preparedContext();
    context.prepared({ turn: 0, context: prepared });
    context.complete({});
    const model = turn.run(() =>
      turn.startModelCall({
        turn: 0,
        modelCallId: "model-call",
        modelId: "model",
        estimatedInputTokens: 3,
      }),
    );
    model.requestCaptured({ context: prepared, selection: selection() });
    (prepared.messages[0] as { content: string }).content = "mutated";
    model.output({
      kind: "text_delta",
      modelCallId: "model-call",
      textSegmentId: "segment",
      delta: "hello",
    });
    model.output({
      kind: "cache_reported",
      report: {
        outcome: "success",
        modelCallId: "model-call",
        scopeId: "scope",
        requestedRetention: "default",
        appliedRetention: "short",
        capability: {
          mode: "automatic_prefix",
          retentions: ["none", "short"],
          stableScopeRetentions: ["short"],
        },
        lifecycle: "append_only",
        commonPrefixMessageCount: 1,
        previousMessageCount: 1,
        currentMessageCount: 2,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        inputTokens: 3,
        cacheHitRate: 1 / 3,
        createdAt: 1,
      },
    });
    model.complete({
      response: response(),
      usage: {
        inputTokens: 3,
        outputTokens: 1,
        totalTokens: 4,
        contextWindow: 100,
        usableInputBudget: 90,
        requestedOutputTokens: 10,
      },
      timeToFirstEventMs: 2,
    });
    turn.finalResponse({ modelCallId: "model-call" });
    turn.complete({ turn: 0 });
    run.complete({});

    expect(spans.map((span) => span.name)).toEqual([
      "agent.run",
      "agent.turn",
      "agent.context.prepare",
      "gen_ai.generate",
      "agent.finish",
    ]);
    expect(spans.map((span) => span.parent)).toEqual([
      undefined,
      "span-1",
      "span-2",
      "span-2",
      "span-1",
    ]);
    expect(spans.every((span) => span.ended === 1)).toBe(true);
    expect(spans.find((span) => span.name === "gen_ai.generate")?.attributes).toMatchObject({
      "agent.model.call.id": "model-call",
      "gen_ai.response.time_to_first_event_ms": 2,
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 1,
    });
    expect(replay.map((event) => event.kind)).toEqual([
      "run.started",
      "user.input",
      "turn.started",
      "context.prepared",
      "model.request.captured",
      "model.started",
      "model.text.delta",
      "model.cache.reported",
      "model.completed",
      "agent.final_response",
      "turn.completed",
      "run.completed",
    ]);
    expect(replay[4]).toMatchObject({
      correlation: { modelCallId: "model-call" },
      payload: {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(replay[7]).toMatchObject({
      kind: "model.cache.reported",
      correlation: { modelCallId: "model-call" },
      payload: {
        event: {
          type: "model_cache_report",
          report: { modelCallId: "model-call", cacheReadTokens: 2 },
        },
      },
    });
  });

  it("keeps processor terminal emission idempotent without Composite", () => {
    const replay: ReplayEventInput[] = [];
    const run = new ReplayRuntimeObserver({ record: (event) => replay.push(event) }).startRun();
    const turn = run.startTurn({ turn: 0 });
    const model = turn.startModelCall({
      turn: 0,
      modelCallId: "model-call",
      modelId: "model",
      estimatedInputTokens: 3,
    });
    const failure = { code: "failed", message: "failed", retryable: false };

    model.complete({
      response: response(),
      usage: {
        inputTokens: 3,
        outputTokens: 1,
        totalTokens: 4,
        contextWindow: 100,
        usableInputBudget: 90,
        requestedOutputTokens: 10,
      },
    });
    model.fail({ failure });

    expect(replay.map((event) => event.kind)).toEqual([
      "run.started",
      "turn.started",
      "model.completed",
    ]);
  });

  it("records failure and cancellation terminals for every replay scope", () => {
    const replay: ReplayEventInput[] = [];
    const run = new ReplayRuntimeObserver({ record: (event) => replay.push(event) }).startRun();
    const turn = run.startTurn({ turn: 0 });
    turn.startContext({ turn: 0 }).cancel({ error: new Error("context cancelled") });
    turn
      .startModelCall({
        turn: 0,
        modelCallId: "model-call",
        modelId: "model",
        estimatedInputTokens: 3,
      })
      .cancel({ error: new Error("model cancelled") });
    const batch = turn.startToolBatch({
      batch: {
        batchId: "batch",
        modelCallId: "model-call",
        members: [
          {
            toolName: "tool",
            toolCallId: "tool-call",
            preview: { action: "execute" },
          },
        ],
      },
    });
    const call = batch.startCall({
      toolName: "tool",
      toolCallId: "tool-call",
      batchId: "batch",
      input: {},
    });
    call
      .startPreflight({ toolName: "tool", toolCallId: "tool-call" })
      .cancel({ error: new Error("preflight cancelled") });
    call
      .startAuthorization({ toolName: "tool", toolCallId: "tool-call" })
      .fail({ error: new Error("authorization failed") });
    call
      .startExecution({ toolName: "tool", toolCallId: "tool-call", batchId: "batch" })
      .cancel({ error: new Error("execution cancelled") });
    call.cancel({ error: new Error("call cancelled") });
    call.fail({ error: new Error("late failure") });
    batch.cancel({ error: new Error("batch cancelled") });
    turn.cancel({ error: new Error("turn cancelled") });
    run.cancel({
      error: new Error("run cancelled"),
      failure: { code: "cancelled", message: "run cancelled", retryable: false },
    });

    expect(replay.map((event) => event.kind)).toEqual([
      "run.started",
      "turn.started",
      "context.cancelled",
      "model.cancelled",
      "tool.batch.started",
      "tool.call.started",
      "tool.preflight.cancelled",
      "tool.authorization.failed",
      "tool.execution.started",
      "tool.execution.cancelled",
      "tool.call.cancelled",
      "tool.batch.cancelled",
      "turn.cancelled",
      "run.cancelled",
    ]);
  });
});

function spanPort(
  spanId: string,
  span: RecordedSpan,
  active: () => string | undefined,
  setActive: (value: string | undefined) => void,
): SpanPort {
  const identity: TraceRunIdentity & { spanId: string } = {
    agentId: "test",
    sessionId: "session",
    runId: "run",
    traceId: "trace",
    spanId,
  };
  return {
    identity,
    setAttribute(key, value) {
      span.attributes[key] = value;
    },
    addEvent() {},
    recordError() {
      span.status = "error";
    },
    setStatus(status) {
      span.status = status;
    },
    run<T>(operation: () => T): T {
      const previous = active();
      setActive(spanId);
      try {
        return operation();
      } finally {
        setActive(previous);
      }
    },
    end() {
      span.ended += 1;
    },
  };
}

function preparedContext(): PreparedModelContext {
  return {
    snapshotId: "snapshot",
    systemPrompt: "system",
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [],
    manifest: {
      snapshotId: "snapshot",
      agentId: "test",
      sessionId: "session",
      sessionRevision: 1,
      modelCallId: "model-call",
      policyStages: [],
      middleware: [],
      sourceMessageCount: 1,
      outputMessageCount: 1,
      sourceDigest: "source",
      contextEntryDigest: "context",
      outputDigest: "output",
      systemPromptDigest: "system",
      toolsetDigest: "tools",
      estimatedInputTokens: 3,
      contextWindow: 100,
      modelMaxOutputTokens: 10,
      requestedOutputTokens: 10,
      usableInputBudget: 90,
      usageRatio: 0.03,
      artifactIds: [],
      decisions: [],
      createdAt: 1,
    },
  };
}

function selection(): RuntimeModelSelection {
  return {
    vendorId: "test",
    connectionId: "default",
    providerId: "test",
    modelId: "model",
    contextWindow: 100,
    modelMaxOutputTokens: 10,
    requestedOutputTokens: 10,
  };
}

function response(): AssistantTranscriptMessage {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "hello" }],
    api: "test",
    provider: "test",
    model: "model",
    stopReason: "stop",
    usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 },
    timestamp: 1,
  };
}
