import { describe, expect, it } from "vitest";

interface CaptureHealth {
  readonly droppedRecords: number;
  readonly message: string;
}

interface PreviewViewModel {
  captureHealth(run: unknown): CaptureHealth | null;
  selectedRun<T extends { runId: string }>(runId: string | null, runs: readonly T[]): T | null;
  buildSpanForest(spans: readonly Span[]): readonly SpanNode[];
  buildDisplayForest(
    spans: readonly Span[],
    replay: readonly Replay[],
    mode?: "overview" | "detailed",
  ): readonly DisplayNode[];
  filterDisplayForest(roots: readonly DisplayNode[], filter?: string): readonly DisplayNode[];
  traceSummary(roots: readonly DisplayNode[]): {
    readonly models: number;
    readonly tools: number;
    readonly compactions: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly cacheHitRate: number | null;
  };
  overviewMetricRows(node: DisplayNode): readonly (readonly [string, string, string?])[];
  relatedToolNodes(
    node: DisplayNode,
    spans: readonly Span[],
    replay: readonly Replay[],
  ): readonly (DisplayNode & { readonly depth: number })[];
  flattenSpanForest<T extends SpanNode>(
    roots: readonly T[],
    collapsedSpanIds?: ReadonlySet<string>,
  ): readonly (T & { depth: number })[];
  focusedSpanForest(roots: readonly SpanNode[], spanId: string | null): readonly SpanNode[];
  traceWindow(
    spans: readonly Span[],
    focusedSpanId: string | null,
    now?: number,
  ): {
    readonly fullStart: number;
    readonly fullFinish: number;
    readonly start: number;
    readonly finish: number;
    readonly focusedSpanId: string | null;
  };
  projectSpanInterval(
    span: Span,
    window: { readonly start: number; readonly finish: number },
    now?: number,
  ): {
    readonly left: number;
    readonly width: number;
    readonly clippedStart: boolean;
    readonly clippedFinish: boolean;
  } | null;
  nodeDetails(
    span: Span,
    spans: readonly Span[],
    replay: readonly Replay[],
    run: unknown,
  ): NodeDetails;
}

interface Span {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status: string;
  readonly attributes: Record<string, string | number | boolean>;
  readonly events: readonly unknown[];
}

interface SpanNode {
  readonly span: Span;
  readonly children: readonly SpanNode[];
}

interface DisplayNode extends SpanNode {
  readonly children: readonly DisplayNode[];
  readonly phases?: readonly SpanNode[];
  readonly metrics?: {
    readonly cache?: {
      readonly readTokens: number;
      readonly writeTokens: number;
      readonly hitRate: number | null;
    };
  };
}

interface Replay {
  readonly seq: number;
  readonly timestamp: number;
  readonly kind: string;
  readonly correlation?: Record<string, string>;
  readonly payload?: unknown;
}

interface NodeDetails {
  readonly input: unknown;
  readonly output: unknown;
  readonly attributes: Record<string, unknown>;
  readonly replayEvents: readonly { readonly kind: string }[];
}

const viewModel = (await import(
  new URL("./view-model.ts", import.meta.url).href
)) as PreviewViewModel;

describe("Trace preview view model", () => {
  it("does not warn for a complete capture", () => {
    expect(viewModel.captureHealth({ status: "completed" })).toBeNull();
  });

  it("describes degraded capture with its dropped record count", () => {
    expect(
      viewModel.captureHealth({
        summary: { capture: { degraded: true, droppedRecords: 3 } },
      }),
    ).toEqual({
      droppedRecords: 3,
      message: "Trace capture is incomplete: 3 records were dropped under storage pressure.",
    });
  });

  it("reconciles a selected run with the latest manifest", () => {
    const stale = { runId: "run", status: "running" };
    const refreshed = {
      runId: "run",
      status: "completed",
      summary: { capture: { degraded: true, droppedRecords: 1 } },
    };

    expect(viewModel.selectedRun(stale.runId, [refreshed])).toBe(refreshed);
    expect(viewModel.captureHealth(viewModel.selectedRun(stale.runId, [refreshed]))).toMatchObject({
      droppedRecords: 1,
    });
  });

  it("builds a stable nested Waterfall and hides collapsed descendants", () => {
    const run = span("run", undefined, "agent.run", 0);
    const turn = span("turn", "run", "agent.turn", 10, { "agent.turn.index": 0 });
    const model = span("model", "turn", "gen_ai.generate", 20, {
      "agent.model.call.id": "model-call",
    });
    const roots = viewModel.buildSpanForest([model, run, turn]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.span.spanId).toBe("run");
    expect(
      viewModel.flattenSpanForest(roots).map(({ span, depth }) => [span.spanId, depth]),
    ).toEqual([
      ["run", 0],
      ["turn", 1],
      ["model", 2],
    ]);
    expect(
      viewModel
        .flattenSpanForest(roots, new Set(["turn"]))
        .map(({ span, depth }) => [span.spanId, depth]),
    ).toEqual([
      ["run", 0],
      ["turn", 1],
    ]);
  });

  it("focuses a Waterfall subtree while preserving one shared time window", () => {
    const run = span("run", undefined, "agent.run", 0);
    const turn = { ...span("turn", "run", "agent.turn", 10), completedAt: 60 };
    const tool = { ...span("tool", "turn", "agent.tool.call", 20), completedAt: 30 };
    const roots = viewModel.buildSpanForest([run, turn, tool]);

    expect(viewModel.focusedSpanForest(roots, "turn")[0]?.span.spanId).toBe("turn");
    expect(
      viewModel
        .flattenSpanForest(viewModel.focusedSpanForest(roots, "turn"))
        .map(({ span, depth }) => [span.spanId, depth]),
    ).toEqual([
      ["turn", 0],
      ["tool", 1],
    ]);
    expect(viewModel.traceWindow([run, turn, tool], "turn", 100)).toMatchObject({
      fullStart: 0,
      start: 10,
      finish: 60,
      focusedSpanId: "turn",
    });
    expect(viewModel.projectSpanInterval(tool, { start: 10, finish: 60 }, 100)).toMatchObject({
      left: 20,
      width: 20,
      clippedStart: false,
      clippedFinish: false,
    });
  });

  it("maps a selected Model span to its correlated request and streamed output", () => {
    const model = span("model", "turn", "gen_ai.generate", 20, {
      "agent.model.call.id": "model-call",
      "gen_ai.request.model": "test-model",
    });
    const replay: Replay[] = [
      record(1, "model.request.captured", { messages: [{ role: "user", content: "hello" }] }),
      record(2, "model.text.delta", { turn: 0, event: { delta: "hel" } }),
      record(3, "model.text.delta", { turn: 0, event: { delta: "lo" } }),
      record(4, "model.completed", { stopReason: "stop", usage: { totalTokens: 4 } }),
    ];

    const details = viewModel.nodeDetails(model, [model], replay, {});

    expect(details.input).toEqual({ messages: [{ role: "user", content: "hello" }] });
    expect(details.output).toEqual({
      text: "hello",
      completion: { stopReason: "stop", usage: { totalTokens: 4 } },
    });
    expect(details.replayEvents.map((event) => event.kind)).toEqual([
      "model.request.captured",
      "model.text.delta",
      "model.text.delta",
      "model.completed",
    ]);
  });

  it("resolves historical Model spans through the recorded Turn correlation", () => {
    const model = span("model", "turn", "gen_ai.generate", 20, {
      "agent.turn.index": 0,
      "gen_ai.request.model": "test-model",
    });
    const replay: Replay[] = [
      record(1, "model.request.captured", { messages: [{ role: "user", content: "legacy" }] }),
      record(2, "model.started", { turn: 0, modelId: "test-model" }),
      record(3, "model.text.delta", { turn: 0, event: { delta: "legacy output" } }),
    ];

    const details = viewModel.nodeDetails(model, [model], replay, {});

    expect(details.input).toEqual({ messages: [{ role: "user", content: "legacy" }] });
    expect(details.output).toEqual({ text: "legacy output" });
  });

  it("keeps Tool input and result scoped to the selected tool call", () => {
    const tool = span("tool", "batch", "agent.tool.call", 20, {
      "agent.tool.call.id": "tool-call",
      "agent.tool.name": "file_read",
    });
    const replay: Replay[] = [
      {
        ...record(1, "tool.call.started", { toolName: "file_read", input: { path: "a.ts" } }),
        correlation: { toolCallId: "tool-call" },
      },
      {
        ...record(2, "tool.result", { result: { content: "source" } }),
        correlation: { toolCallId: "tool-call" },
      },
      {
        ...record(3, "tool.result", { result: { content: "unrelated" } }),
        correlation: { toolCallId: "another-call" },
      },
    ];

    const details = viewModel.nodeDetails(tool, [tool], replay, {});

    expect(details.input).toEqual({ path: "a.ts" });
    expect(details.output).toEqual({ result: { content: "source" } });
    expect(details.replayEvents).toHaveLength(2);
  });

  it("keeps Model-to-Tool correlation and expanded Tool data available to the view", () => {
    const run = span("run", undefined, "agent.run", 0);
    const turn = span("turn", "run", "agent.turn", 10, { "agent.turn.index": 0 });
    const model = span("model", "turn", "gen_ai.generate", 20, {
      "agent.model.call.id": "model-call",
    });
    const batch = span("batch", "turn", "agent.tool.batch", 30);
    const tool = span("tool", "batch", "agent.tool.call", 31, {
      "agent.tool.call.id": "tool-call",
      "agent.tool.name": "file_read",
    });
    const replay: Replay[] = [
      {
        ...record(1, "tool.batch.started", {}),
        correlation: { modelCallId: "model-call", batchId: "batch-id" },
      },
      {
        ...record(2, "tool.call.started", { input: { path: "a.ts" } }),
        correlation: { batchId: "batch-id", toolCallId: "tool-call" },
      },
    ];
    const nodes = viewModel.flattenSpanForest(
      viewModel.buildDisplayForest([run, turn, model, batch, tool], replay),
    ) as readonly (DisplayNode & { readonly depth: number })[];
    const modelNode = nodes.find(({ span: candidate }) => candidate.spanId === "model");

    expect(modelNode).toBeDefined();
    expect(
      viewModel
        .relatedToolNodes(modelNode!, [run, turn, model, batch, tool], replay)
        .map(({ span: candidate }) => candidate.spanId),
    ).toEqual(["tool"]);
  });

  it("preserves detailed model, cache, phase, and aggregate overview metrics", () => {
    const model = span("model", undefined, "gen_ai.generate", 20, {
      "gen_ai.usage.input_tokens": 80,
      "gen_ai.usage.output_tokens": 20,
      "agent.model.call.id": "model-call",
    });
    const replay: Replay[] = [
      {
        ...record(1, "model.cache.reported", {
          event: {
            report: {
              modelCallId: "model-call",
              inputTokens: 80,
              cacheReadTokens: 40,
              cacheWriteTokens: 0,
              cacheHitRate: 0.5,
              lifecycle: "hit",
              appliedRetention: "session",
              outcome: "success",
            },
          },
        }),
        correlation: { modelCallId: "model-call" },
      },
    ];
    const node = viewModel.buildDisplayForest([model], replay)[0];

    expect(node).toBeDefined();
    expect(viewModel.overviewMetricRows(node!).map(([label]) => label)).toEqual([
      "Started",
      "Input tokens",
      "Output tokens",
      "Total tokens",
      "Cache hit",
      "Cache read",
      "Cache write",
      "Cache lifecycle",
      "Cache retention",
    ]);
  });

  it("inherits Tool correlation for historical nested guard spans", () => {
    const tool = span("tool", "batch", "agent.tool.call", 20, {
      "agent.tool.call.id": "tool-call",
    });
    const access = span("access", "tool", "agent.tool.access", 21);
    const replay: Replay[] = [
      {
        ...record(1, "tool.access.completed", {
          outcome: "allowed",
          accessMs: 2,
        }),
        correlation: { toolCallId: "tool-call" },
      },
    ];

    const details = viewModel.nodeDetails(access, [tool, access], replay, {});

    expect(details.output).toEqual({ outcome: "allowed", accessMs: 2 });
    expect(details.replayEvents).toHaveLength(1);
  });

  it("builds a quiet Overview while preserving Tool lifecycle phases", () => {
    const run = span("run", undefined, "agent.run", 0);
    const turn = span("turn", "run", "agent.turn", 1, { "agent.turn.index": 0 });
    const batch = span("batch", "turn", "agent.tool.batch", 2);
    const tool = span("tool", "batch", "agent.tool.call", 3, {
      "agent.tool.call.id": "tool-call",
      "agent.tool.name": "file_read",
    });
    const preflight = span("preflight", "tool", "agent.tool.preflight", 4);
    const access = span("access", "tool", "agent.tool.access", 5);
    const execution = span("execution", "tool", "agent.tool.execution", 6);

    const overview = viewModel.buildDisplayForest(
      [run, turn, batch, tool, preflight, access, execution],
      [],
    );
    const rows = viewModel.flattenSpanForest(overview);

    expect(rows.map(({ span: item }) => item.name)).toEqual([
      "agent.run",
      "agent.turn",
      "agent.tool.call",
    ]);
    expect(rows[2]?.phases?.map(({ span: item }) => item.name)).toEqual([
      "agent.tool.preflight",
      "agent.tool.access",
      "agent.tool.execution",
    ]);
    expect(
      viewModel
        .flattenSpanForest(
          viewModel.buildDisplayForest(
            [run, turn, batch, tool, preflight, access, execution],
            [],
            "detailed",
          ),
        )
        .map(({ span: item }) => item.name),
    ).toContain("agent.tool.access");
  });

  it("associates Prompt Cache with its Model and aggregates token-weighted hit rate", () => {
    const run = span("run", undefined, "agent.run", 0);
    const turn = span("turn", "run", "agent.turn", 1, { "agent.turn.index": 0 });
    const model = span("model", "turn", "gen_ai.generate", 2, {
      "agent.model.call.id": "model-call",
      "gen_ai.usage.input_tokens": 40,
      "gen_ai.usage.output_tokens": 5,
    });
    const replay: Replay[] = [
      {
        ...record(1, "model.cache.reported", {
          turn: 0,
          event: {
            type: "model_cache_report",
            report: {
              modelCallId: "model-call",
              cacheReadTokens: 50,
              cacheWriteTokens: 10,
              inputTokens: 40,
              cacheHitRate: 0.5,
              lifecycle: "append_only",
              outcome: "success",
            },
          },
        }),
        correlation: { modelCallId: "model-call" },
      },
    ];

    const overview = viewModel.buildDisplayForest([run, turn, model], replay);
    const modelNode = viewModel
      .flattenSpanForest(overview)
      .find(({ span: item }) => item.name === "gen_ai.generate");
    const summary = viewModel.traceSummary(overview);

    expect(modelNode?.metrics?.cache).toMatchObject({
      readTokens: 50,
      writeTokens: 10,
      hitRate: 0.5,
    });
    expect(summary).toMatchObject({
      models: 1,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      cacheHitRate: 0.5,
    });
  });

  it("projects compression and checkpoint facts as Context lifecycle nodes", () => {
    const run = { ...span("run", undefined, "agent.run", 0), completedAt: 100 };
    const turn = {
      ...span("turn", "run", "agent.turn", 1, { "agent.turn.index": 0 }),
      completedAt: 90,
    };
    const context = {
      ...span("context", "turn", "agent.context.prepare", 2, { "agent.turn.index": 0 }),
      completedAt: 30,
    };
    const replay: Replay[] = [
      record(1, "context.progress", {
        turn: 0,
        event: {
          type: "context_progress",
          event: {
            type: "compression_started",
            compressionId: "compression",
            modelCallId: "model-call",
            beforeTokens: 96_000,
          },
        },
      }),
      {
        ...record(2, "context.progress", {
          turn: 0,
          event: {
            type: "context_progress",
            event: {
              type: "compression_completed",
              compressionId: "compression",
              modelCallId: "model-call",
              report: {
                beforeTokens: 96_000,
                afterTokens: 28_000,
                tokenDelta: 68_000,
                reductionRatio: 68_000 / 96_000,
                operations: [],
                durationMs: 1,
              },
            },
          },
        }),
        timestamp: 20,
      },
      {
        ...record(3, "context.prepared", {
          turn: 0,
          event: {
            manifest: {
              modelCallId: "model-call",
              checkpoint: {
                action: "create",
                checkpointId: "checkpoint",
                coveredMessageCount: 12,
              },
            },
          },
        }),
        timestamp: 25,
      },
    ];

    const overview = viewModel.buildDisplayForest([run, turn, context], replay);
    const overviewNames = viewModel.flattenSpanForest(overview).map(({ span: item }) => item.name);
    const detailedNames = viewModel
      .flattenSpanForest(viewModel.buildDisplayForest([run, turn, context], replay, "detailed"))
      .map(({ span: item }) => item.name);

    expect(overviewNames).toContain("context.compaction");
    expect(overviewNames).not.toContain("context.checkpoint");
    expect(detailedNames).toContain("context.checkpoint");
    expect(viewModel.traceSummary(overview).compactions).toBe(1);
  });
});

function span(
  spanId: string,
  parentSpanId: string | undefined,
  name: string,
  startedAt: number,
  attributes: Record<string, string | number | boolean> = {},
): Span {
  return {
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    startedAt,
    completedAt: startedAt + 10,
    status: "ok",
    attributes,
    events: [],
  };
}

function record(seq: number, kind: string, payload: unknown): Replay {
  return {
    seq,
    timestamp: seq,
    kind,
    correlation: { modelCallId: "model-call" },
    payload,
  };
}
