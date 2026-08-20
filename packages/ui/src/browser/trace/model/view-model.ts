import type {
  CacheReport,
  DisplayMetrics,
  DisplayNode,
  FlattenedDisplayNode,
  NodeDetails,
  SpanNode,
  TraceReplayRecord,
  TraceRun,
  TraceSpan,
  TraceTimeWindow,
} from "./contracts.js";

/** Pure projections from trace transport records into browser presentation models. */
const TERMINAL_ERROR_STATUSES = new Set(["error", "denied", "timed_out", "cancelled"]);

const SPAN_PRESENTATION: Readonly<
  Record<string, { readonly label: string; readonly kind: string }>
> = {
  "agent.run": { label: "Agent run", kind: "run" },
  "agent.turn": { label: "Turn", kind: "turn" },
  "agent.environment.capture": { label: "Capture environment", kind: "context" },
  "agent.session.append_input": { label: "Append input", kind: "session" },
  "agent.session.persist_output": { label: "Persist output", kind: "session" },
  "agent.context.prepare": { label: "Prepare context", kind: "context" },
  "gen_ai.generate": { label: "Model call", kind: "model" },
  "agent.tool.batch": { label: "Tool batch", kind: "batch" },
  "agent.tool.call": { label: "Tool call", kind: "tool" },
  "agent.tool.preflight": { label: "Preflight", kind: "guard" },
  "agent.tool.authorization": { label: "Authorization", kind: "guard" },
  "agent.tool.execution": { label: "Execution", kind: "execution" },
  "agent.finish": { label: "Finish", kind: "finish" },
  "context.compaction": { label: "Context compacted", kind: "compaction" },
  "context.checkpoint": { label: "Context checkpoint", kind: "checkpoint" },
};

const OVERVIEW_SPANS = new Set([
  "agent.run",
  "agent.turn",
  "gen_ai.generate",
  "agent.tool.call",
  "context.compaction",
  "context.checkpoint",
]);

const TOOL_PHASES = new Set([
  "agent.tool.preflight",
  "agent.tool.authorization",
  "agent.tool.execution",
]);

export function captureHealth(run: TraceRun | null | undefined): {
  readonly droppedRecords: number;
  readonly message: string;
} | null {
  const capture = run?.summary?.capture;
  if (capture?.degraded !== true) return null;
  const droppedRecords =
    typeof capture.droppedRecords === "number" && Number.isSafeInteger(capture.droppedRecords)
      ? capture.droppedRecords
      : 0;
  return {
    droppedRecords,
    message: `Trace capture is incomplete: ${droppedRecords} ${droppedRecords === 1 ? "record was" : "records were"} dropped under storage pressure.`,
  };
}

export function selectedRun<T extends { readonly runId: string }>(
  runId: string | null,
  runs: readonly T[],
): T | null {
  if (!runId) return null;
  return runs.find((run) => run.runId === runId) ?? null;
}

export function buildSpanForest(spans: readonly TraceSpan[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>(
    spans.map((span) => [span.spanId, { span, children: [] }]),
  );
  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentSpanId ? nodes.get(node.span.parentSpanId) : undefined;
    if (parent && hasValidAncestry(node, parent, nodes)) parent.children.push(node);
    else roots.push(node);
  }
  sortNodes(roots);
  return roots;
}

export function buildDisplayForest(
  spans: readonly TraceSpan[],
  replay: readonly TraceReplayRecord[],
  mode: "overview" | "detailed" = "overview",
): DisplayNode[] {
  const synthetic = contextLifecycleSpans(spans, replay);
  const roots = buildSpanForest([...spans, ...synthetic]);
  const cacheByModelCall = modelCacheReports(replay);

  const detailed = (node: SpanNode): DisplayNode => ({
    span: node.span,
    children: node.children.map(detailed),
    phases: node.children.filter((child) => TOOL_PHASES.has(child.span.name)),
    metrics: displayMetrics(node.span, cacheByModelCall),
  });

  if (mode === "detailed") return roots.map(detailed);

  const project = (node: SpanNode): DisplayNode[] => {
    const children = node.children.flatMap((child) => project(child));
    const phases = node.children.filter((child) => TOOL_PHASES.has(child.span.name));
    const display = {
      span: node.span,
      children,
      phases,
      metrics: displayMetrics(node.span, cacheByModelCall),
    };
    if (overviewVisible(node.span)) return [display];
    return children;
  };

  return roots.flatMap((root) => project(root));
}

export function filterDisplayForest(roots: readonly DisplayNode[], filter = "all"): DisplayNode[] {
  if (filter === "all") return [...roots];
  const visit = (node: DisplayNode): DisplayNode[] => {
    const children = node.children.flatMap((child) => visit(child));
    return displayNodeMatches(node, filter) || children.length > 0 ? [{ ...node, children }] : [];
  };
  return roots.flatMap((root) => visit(root));
}

export function traceSummary(roots: readonly DisplayNode[]): {
  readonly models: number;
  readonly tools: number;
  readonly compactions: number;
  readonly errors: number;
  readonly tokenUsage: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheHitRate: number | null;
  readonly authorizationMs: number;
} {
  const nodes = flattenSpanForest(roots);
  const semantic = nodes.filter(({ span }) => !["agent.run", "agent.turn"].includes(span.name));
  const models = semantic.filter(({ span }) => span.name === "gen_ai.generate");
  const tools = semantic.filter(({ span }) => span.name === "agent.tool.call");
  const compactions = semantic.filter(({ span }) => span.name === "context.compaction");
  const errors = semantic.filter(({ span }) => spanPresentation(span).statusTone === "error");
  const tokenUsage = models.reduce(
    (total, { metrics }) => total + Number(metrics?.tokens?.total ?? 0),
    0,
  );
  const cacheReadTokens = models.reduce(
    (total, { metrics }) => total + Number(metrics?.cache?.readTokens ?? 0),
    0,
  );
  const cacheWriteTokens = models.reduce(
    (total, { metrics }) => total + Number(metrics?.cache?.writeTokens ?? 0),
    0,
  );
  const cacheInputTokens = models.reduce(
    (total, { metrics }) => total + Number(metrics?.cache?.inputTokens ?? 0),
    0,
  );
  const cacheDenominator = cacheInputTokens + cacheReadTokens + cacheWriteTokens;
  const waitingMs = tools.reduce(
    (total, { phases }) =>
      total +
      (phases ?? [])
        .filter(({ span }) => span.name === "agent.tool.authorization")
        .reduce((sum, { span }) => sum + spanDuration(span), 0),
    0,
  );
  return {
    models: models.length,
    tools: tools.length,
    compactions: compactions.length,
    errors: errors.length,
    tokenUsage,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRate: cacheDenominator > 0 ? cacheReadTokens / cacheDenominator : null,
    authorizationMs: waitingMs,
  };
}

export type OverviewMetricRow = readonly [label: string, value: string, tone?: string];

export interface CachePresentation {
  readonly visible: boolean;
  readonly label: string;
  readonly tone: string;
  readonly tooltip: string;
}

export function cachePresentation(cache: NonNullable<DisplayMetrics["cache"]>): CachePresentation {
  const lifecycle = String(cache.lifecycle ?? "unknown");
  const retention = String(cache.appliedRetention ?? "none");
  const tone =
    cache.outcome !== "success" || ["expired", "incompatible"].includes(lifecycle)
      ? "warning"
      : cache.readTokens > 0
        ? "hit"
        : "write";
  const label =
    cache.outcome !== "success"
      ? `CACHE ${String(cache.outcome).toUpperCase()}`
      : ["expired", "incompatible"].includes(lifecycle)
        ? `CACHE ${lifecycle.toUpperCase()}`
        : cache.hitRate !== null
          ? `CACHE ${formatPercent(cache.hitRate)}`
          : cache.writeTokens > 0
            ? "CACHE WRITE"
            : "CACHE";
  return {
    visible:
      cache.readTokens > 0 ||
      cache.writeTokens > 0 ||
      cache.outcome !== "success" ||
      ["expired", "incompatible", "prefix_rewritten", "rebased"].includes(lifecycle),
    label,
    tone,
    tooltip: [
      `Lifecycle: ${lifecycle}`,
      `Read: ${formatCompactNumber(cache.readTokens)} tokens`,
      `Write: ${formatCompactNumber(cache.writeTokens)} tokens`,
      `Retention: ${retention}`,
      ...(cache.reason ? [`Reason: ${String(cache.reason)}`] : []),
    ].join("\n"),
  };
}

export function overviewMetricRows(node: DisplayNode): OverviewMetricRow[] {
  const rows: OverviewMetricRow[] = [
    ["Started", new Date(node.span.startedAt).toLocaleTimeString()],
  ];
  const tokens = node.metrics.tokens;
  if (tokens && tokens.total > 0) {
    rows.push(
      ["Input tokens", formatCompactNumber(tokens.input)],
      ["Output tokens", formatCompactNumber(tokens.output)],
      ["Total tokens", formatCompactNumber(tokens.total)],
    );
  }
  const cache = node.metrics.cache;
  if (cache) {
    const presentation = cachePresentation(cache);
    rows.push(
      [
        "Cache hit",
        cache.hitRate === null ? "Unavailable" : formatPercent(cache.hitRate),
        presentation.tone,
      ],
      ["Cache read", `${formatCompactNumber(cache.readTokens)} tokens`],
      ["Cache write", `${formatCompactNumber(cache.writeTokens)} tokens`],
      ["Cache lifecycle", String(cache.lifecycle ?? "unknown")],
      ["Cache retention", String(cache.appliedRetention ?? "none")],
    );
  } else if (spanPresentation(node.span).kind === "model") {
    rows.push(["Cache", "Not reported", "muted"]);
  }
  for (const { span } of node.phases) {
    rows.push([
      capitalize(span.name.split(".").at(-1) ?? "phase"),
      formatDuration(spanDuration(span)),
    ]);
  }
  if (node.span.name === "context.compaction") {
    const before = numeric(node.span.attributes["context.before_tokens"]);
    const after = numeric(node.span.attributes["context.after_tokens"]);
    if (before > 0)
      rows.push([
        "Context",
        `${formatCompactNumber(before)} → ${formatCompactNumber(after)} tokens`,
      ]);
    const reduction = node.span.attributes["context.reduction_ratio"];
    if (typeof reduction === "number") rows.push(["Reduction", formatPercent(reduction)]);
  }
  if (["agent.run", "agent.turn"].includes(node.span.name)) {
    const summary = traceSummary([node]);
    rows.push(["Models", String(summary.models)], ["Tools", String(summary.tools)]);
    if (summary.tokenUsage > 0) rows.push(["Tokens", formatCompactNumber(summary.tokenUsage)]);
    if (summary.cacheHitRate !== null) {
      rows.push(["Cache hit", formatPercent(summary.cacheHitRate), "hit"]);
    }
    if (summary.compactions > 0) rows.push(["Compactions", String(summary.compactions)]);
    if (summary.errors > 0) rows.push(["Errors", String(summary.errors), "error"]);
  }
  return rows;
}

export function relatedToolNodes(
  node: DisplayNode,
  spans: readonly TraceSpan[],
  replay: readonly TraceReplayRecord[],
): FlattenedDisplayNode[] {
  const rows = flattenSpanForest(buildDisplayForest(spans, replay, "overview"));
  const tools = rows.filter(({ span }) => span.name === "agent.tool.call");
  if (node.span.name === "agent.run") return tools;
  const selected = rows.find(({ span }) => span.spanId === node.span.spanId);
  if (node.span.name === "agent.turn" && selected) {
    return flattenSpanForest([selected]).filter(({ span }) => span.name === "agent.tool.call");
  }
  if (node.span.name !== "gen_ai.generate") return [];
  const modelCallId = node.span.attributes["agent.model.call.id"];
  if (typeof modelCallId !== "string") return [];
  const batchIds = new Set(
    replay.flatMap((record) =>
      record.correlation?.modelCallId === modelCallId && record.correlation.batchId
        ? [record.correlation.batchId]
        : [],
    ),
  );
  const toolCallIds = new Set(
    replay.flatMap((record) =>
      record.correlation?.batchId &&
      batchIds.has(record.correlation.batchId) &&
      record.correlation.toolCallId
        ? [record.correlation.toolCallId]
        : [],
    ),
  );
  return tools.filter(({ span }) => {
    const toolCallId = span.attributes["agent.tool.call.id"];
    return typeof toolCallId === "string" && toolCallIds.has(toolCallId);
  });
}

export function criticalSpanIds(roots: readonly DisplayNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (node: DisplayNode): void => {
    ids.add(node.span.spanId);
    const candidates = node.children.filter(({ span }) => span.completedAt !== undefined);
    if (!candidates.length) return;
    const dominant = [...candidates].sort(
      (left, right) =>
        spanDuration(right.span) - spanDuration(left.span) ||
        left.span.startedAt - right.span.startedAt,
    )[0];
    if (dominant) visit(dominant);
  };
  for (const root of roots) visit(root);
  return ids;
}

export function flattenSpanForest(
  roots: readonly DisplayNode[],
  collapsedSpanIds: ReadonlySet<string> = new Set(),
): FlattenedDisplayNode[] {
  const rows: FlattenedDisplayNode[] = [];
  const visit = (node: DisplayNode, depth: number): void => {
    rows.push({ ...node, depth });
    if (collapsedSpanIds.has(node.span.spanId)) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

export function focusedSpanForest(
  roots: readonly DisplayNode[],
  spanId: string | null,
): readonly DisplayNode[] {
  if (!spanId) return roots;
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.span.spanId === spanId) return [node];
    pending.push(...node.children);
  }
  return roots;
}

export function traceWindow(
  spans: readonly TraceSpan[],
  focusedSpanId: string | null,
  now = Date.now(),
): TraceTimeWindow {
  const fullStart = Math.min(...spans.map((span) => span.startedAt));
  const fullFinish = Math.max(...spans.map((span) => span.completedAt || now), fullStart + 1);
  const focused = focusedSpanId ? spans.find((span) => span.spanId === focusedSpanId) : undefined;
  const start = focused?.startedAt ?? fullStart;
  const finish = Math.max(focused?.completedAt || (focused ? now : fullFinish), start + 1);
  return { fullStart, fullFinish, start, finish, focusedSpanId: focused?.spanId ?? null };
}

export function projectSpanInterval(
  span: TraceSpan,
  window: Pick<TraceTimeWindow, "start" | "finish">,
  now = Date.now(),
): {
  readonly left: number;
  readonly width: number;
  readonly clippedStart: boolean;
  readonly clippedFinish: boolean;
} | null {
  const finish = span.completedAt || now;
  if (finish < window.start || span.startedAt > window.finish) return null;
  const total = window.finish - window.start;
  const visibleStart = Math.max(span.startedAt, window.start);
  const visibleFinish = Math.min(finish, window.finish);
  return {
    left: ((visibleStart - window.start) / total) * 100,
    width: ((visibleFinish - visibleStart) / total) * 100,
    clippedStart: span.startedAt < window.start,
    clippedFinish: finish > window.finish,
  };
}

export function spanPresentation(span: TraceSpan): {
  readonly label: string;
  readonly kind: string;
  readonly statusTone: "running" | "error" | "success";
} {
  const base = SPAN_PRESENTATION[span.name] ?? { label: span.name, kind: "operation" };
  const attributes = span.attributes ?? {};
  const turn = attributes["agent.turn.index"];
  const tool = attributes["agent.tool.name"];
  const model = attributes["gen_ai.request.model"];
  const contextOperation = attributes["context.operation"];
  const label =
    span.name === "agent.turn" && turn !== undefined
      ? `Turn ${Number(turn) + 1}`
      : span.name === "agent.tool.call" && tool
        ? String(tool)
        : span.name === "gen_ai.generate" && model
          ? String(model)
          : span.name === "context.checkpoint" && contextOperation
            ? `Checkpoint ${String(contextOperation)}`
            : base.label;
  return {
    ...base,
    label,
    statusTone:
      span.status === "running"
        ? "running"
        : TERMINAL_ERROR_STATUSES.has(span.status)
          ? "error"
          : "success",
  };
}

export function displayNodeDetails(
  node: DisplayNode,
  spans: readonly TraceSpan[],
  replay: readonly TraceReplayRecord[],
  run: TraceRun | null,
): NodeDetails {
  if (!node.span.synthetic) return nodeDetails(node.span, spans, replay, run);
  return {
    input: node.span.attributes?.["context.trigger"] ?? null,
    output: node.span.attributes?.["context.report"] ?? node.span.attributes,
    attributes: {
      status: node.span.status,
      startedAt: node.span.startedAt,
      ...(node.span.completedAt ? { completedAt: node.span.completedAt } : {}),
      durationMs: node.span.completedAt ? node.span.completedAt - node.span.startedAt : 0,
      spanId: node.span.spanId,
      ...node.span.attributes,
    },
    spanEvents: [],
    replayEvents: node.replayRecords ?? [],
  };
}

export function nodeDetails(
  span: TraceSpan,
  spans: readonly TraceSpan[],
  replay: readonly TraceReplayRecord[],
  run: TraceRun | null,
): NodeDetails {
  const records = relatedReplay(span, spans, replay);
  return {
    input: nodeInput(span, records),
    output: nodeOutput(span, records, replay, run),
    attributes: {
      status: span.status,
      startedAt: span.startedAt,
      ...(span.completedAt ? { completedAt: span.completedAt } : {}),
      durationMs: span.completedAt ? span.completedAt - span.startedAt : null,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      ...(span.error ? { error: span.error } : {}),
      ...span.attributes,
    },
    spanEvents: span.events ?? [],
    replayEvents: records.map(({ seq, timestamp, kind, correlation }) => ({
      seq,
      timestamp,
      kind,
      correlation,
    })),
  };
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "active";
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function hasValidAncestry(
  node: SpanNode,
  parent: SpanNode,
  nodes: ReadonlyMap<string, SpanNode>,
): boolean {
  let current = parent;
  for (let count = 0; count <= nodes.size; count++) {
    if (current === node) return false;
    const parentId = current.span.parentSpanId;
    if (!parentId) return true;
    const next = nodes.get(parentId);
    if (!next) return true;
    current = next;
  }
  return false;
}

function sortNodes(nodes: SpanNode[]): void {
  nodes.sort(
    (left, right) =>
      left.span.startedAt - right.span.startedAt ||
      left.span.spanId.localeCompare(right.span.spanId),
  );
  for (const node of nodes) sortNodes(node.children);
}

function overviewVisible(span: TraceSpan): boolean {
  if (OVERVIEW_SPANS.has(span.name)) {
    return span.attributes?.["trace.overview.hidden"] !== true;
  }
  return TERMINAL_ERROR_STATUSES.has(span.status);
}

function displayNodeMatches(node: DisplayNode, filter: string): boolean {
  const { span, metrics } = node;
  if (span.name === "agent.run" || span.name === "agent.turn") return false;
  if (filter === "models") return span.name === "gen_ai.generate";
  if (filter === "tools") return span.name === "agent.tool.call";
  if (filter === "context") return span.name.startsWith("context.");
  if (filter === "errors") return spanPresentation(span).statusTone === "error";
  if (filter === "authorization")
    return (node.phases ?? []).some(
      ({ span: phase }) => phase.name === "agent.tool.authorization" && spanDuration(phase) > 0,
    );
  if (filter === "cache") {
    return Boolean(
      metrics?.cache && (metrics.cache.readTokens > 0 || metrics.cache.writeTokens > 0),
    );
  }
  if (filter === "slow") return spanDuration(span) >= 1_000;
  return true;
}

function displayMetrics(
  span: TraceSpan,
  cacheByModelCall: ReadonlyMap<string, CacheReport>,
): DisplayMetrics {
  if (span.name !== "gen_ai.generate") return {};
  const input = numeric(span.attributes?.["gen_ai.usage.input_tokens"]);
  const output = numeric(span.attributes?.["gen_ai.usage.output_tokens"]);
  const modelCallId = span.attributes?.["agent.model.call.id"];
  const cache = modelCallId ? cacheByModelCall.get(String(modelCallId)) : undefined;
  return {
    tokens: { input, output, total: input + output },
    ...(cache
      ? {
          cache: {
            readTokens: numeric(cache.cacheReadTokens),
            writeTokens: numeric(cache.cacheWriteTokens),
            inputTokens: numeric(cache.inputTokens),
            hitRate: typeof cache.cacheHitRate === "number" ? cache.cacheHitRate : null,
            lifecycle: cache.lifecycle,
            requestedRetention: cache.requestedRetention,
            appliedRetention: cache.appliedRetention,
            outcome: cache.outcome,
            reason: cache.reason,
            report: cache,
          },
        }
      : {}),
  };
}

function modelCacheReports(replay: readonly TraceReplayRecord[]): Map<string, CacheReport> {
  const reports = new Map<string, CacheReport>();
  for (const record of replay) {
    if (record.kind !== "model.cache.reported") continue;
    const payload = payloadOf(record);
    const report = payload?.event?.report;
    const modelCallId = record.correlation?.modelCallId ?? report?.modelCallId;
    if (modelCallId && report) reports.set(String(modelCallId), report);
  }
  return reports;
}

function contextLifecycleSpans(
  spans: readonly TraceSpan[],
  replay: readonly TraceReplayRecord[],
): TraceSpan[] {
  const result: TraceSpan[] = [];
  const started = new Map<
    string,
    {
      readonly record: TraceReplayRecord;
      readonly event: NonNullable<ReturnType<typeof contextEvent>>;
      readonly turn?: number;
    }
  >();
  const completedModelCalls = new Set<string>();
  for (const record of replay) {
    if (record.kind !== "context.progress") continue;
    const payload = payloadOf(record);
    const event = contextEvent(payload ?? undefined);
    if (!event?.type || !event.compressionId) continue;
    if (event.type === "compression_started") {
      started.set(event.compressionId, { record, event, turn: payload?.turn });
      continue;
    }
    const beginning = started.get(event.compressionId);
    const turn = payload?.turn ?? beginning?.turn;
    const parentSpanId = contextParentSpanId(spans, turn, record.timestamp);
    const failed = event.type === "compression_failed";
    const report = event.report;
    if (event.modelCallId) completedModelCalls.add(event.modelCallId);
    result.push({
      spanId: `context:compaction:${event.compressionId}`,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: "context.compaction",
      startedAt: beginning?.record.timestamp ?? record.timestamp,
      completedAt: record.timestamp,
      status: failed ? (event.cancelled ? "cancelled" : "error") : "ok",
      synthetic: true,
      attributes: {
        "context.operation": "compaction",
        "agent.turn.index": turn,
        "agent.model.call.id": event.modelCallId,
        "context.before_tokens": report?.beforeTokens ?? beginning?.event.beforeTokens,
        ...(report
          ? {
              "context.after_tokens": report.afterTokens,
              "context.token_delta": report.tokenDelta,
              "context.reduction_ratio": report.reductionRatio,
              "context.duration_ms": report.durationMs,
              "context.operations": report.operations,
              "context.trigger": report.trigger,
              "context.report": report,
            }
          : {}),
        ...(failed ? { "context.failure_reason": event.reason } : {}),
      },
      events: [],
    });
  }

  for (const record of replay) {
    if (record.kind !== "context.prepared") continue;
    const payload = payloadOf(record);
    const manifest = payload?.event?.manifest;
    const checkpoint = manifest?.checkpoint;
    if (!manifest || !checkpoint?.action || !checkpoint.checkpointId) continue;
    const parentSpanId = contextParentSpanId(spans, payload?.turn, record.timestamp);
    result.push({
      spanId: `context:checkpoint:${manifest.modelCallId}:${checkpoint.checkpointId}:${checkpoint.action}`,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: "context.checkpoint",
      startedAt: record.timestamp,
      completedAt: record.timestamp,
      status: "ok",
      synthetic: true,
      attributes: {
        "context.operation": checkpoint.action,
        "context.checkpoint.id": checkpoint.checkpointId,
        "context.covered_message_count": checkpoint.coveredMessageCount,
        "agent.turn.index": payload?.turn,
        "agent.model.call.id": manifest?.modelCallId,
        "trace.overview.hidden":
          checkpoint.action !== "reuse" &&
          typeof manifest?.modelCallId === "string" &&
          completedModelCalls.has(manifest.modelCallId),
      },
      events: [],
    });
  }
  return result;
}

function contextParentSpanId(
  spans: readonly TraceSpan[],
  turn: number | undefined,
  timestamp: number,
): string | undefined {
  const context = spans.find(
    (span) =>
      span.name === "agent.context.prepare" &&
      span.attributes?.["agent.turn.index"] === turn &&
      span.startedAt <= timestamp &&
      (span.completedAt === undefined || span.completedAt >= timestamp),
  );
  if (context) return context.spanId;
  return spans.find(
    (span) => span.name === "agent.turn" && span.attributes?.["agent.turn.index"] === turn,
  )?.spanId;
}

function spanDuration(span: TraceSpan): number {
  return Math.max(0, (span.completedAt ?? span.startedAt) - span.startedAt);
}

function numeric(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function relatedReplay(
  span: TraceSpan,
  spans: readonly TraceSpan[],
  replay: readonly TraceReplayRecord[],
): TraceReplayRecord[] {
  if (span.name === "agent.run") return [...replay];
  const attributes = span.attributes ?? {};
  const turn =
    attributes["agent.turn.index"] ?? inheritedAttribute(span, spans, "agent.turn.index");
  const modelCallId = attributes["agent.model.call.id"];
  const batchId =
    attributes["agent.tool.batch.id"] ?? inheritedAttribute(span, spans, "agent.tool.batch.id");
  const toolCallId =
    attributes["agent.tool.call.id"] ?? inheritedAttribute(span, spans, "agent.tool.call.id");
  const descendants = descendantCorrelation(span.spanId, spans);
  const modelCallIds = new Set<unknown>(modelCallId ? [modelCallId] : []);
  if (turn !== undefined && (span.name === "agent.turn" || span.name === "gen_ai.generate")) {
    for (const record of replay) {
      if (record.kind === "model.started" && record.payload?.turn === turn) {
        add(modelCallIds, record.correlation?.modelCallId);
      }
    }
  }
  return replay.filter((record) => {
    if (!kindBelongsToSpan(span.name, record.kind)) return false;
    if (modelCallIds.has(record.correlation?.modelCallId)) return true;
    if (batchId && record.correlation?.batchId === batchId) return true;
    if (toolCallId && record.correlation?.toolCallId === toolCallId) return true;
    if (turn !== undefined && record.payload?.turn === turn) return true;
    if (span.name === "agent.turn") {
      return (
        descendants.modelCallIds.has(record.correlation?.modelCallId) ||
        modelCallIds.has(record.correlation?.modelCallId) ||
        descendants.batchIds.has(record.correlation?.batchId) ||
        descendants.toolCallIds.has(record.correlation?.toolCallId)
      );
    }
    return span.name === "agent.finish" && record.kind.startsWith("run.");
  });
}

function kindBelongsToSpan(spanName: string, kind: string): boolean {
  switch (spanName) {
    case "agent.turn":
      return true;
    case "agent.context.prepare":
      return kind.startsWith("context.");
    case "gen_ai.generate":
      return kind.startsWith("model.") || kind === "agent.final_response";
    case "agent.tool.batch":
      return kind.startsWith("tool.batch.");
    case "agent.tool.call":
      return (
        kind === "tool.call.started" || kind === "tool.result" || kind.startsWith("tool.call.")
      );
    case "agent.tool.preflight":
      return kind.startsWith("tool.preflight.");
    case "agent.tool.authorization":
      return kind.startsWith("tool.authorization.");
    case "agent.tool.execution":
      return kind.startsWith("tool.execution.");
    case "agent.environment.capture":
      return kind.startsWith("environment.");
    case "agent.session.append_input":
      return kind === "user.input";
    case "agent.session.persist_output":
      return kind === "agent.final_response" || kind.startsWith("run.");
    default:
      return true;
  }
}

function descendantCorrelation(
  spanId: string,
  spans: readonly TraceSpan[],
): {
  readonly modelCallIds: Set<unknown>;
  readonly batchIds: Set<unknown>;
  readonly toolCallIds: Set<unknown>;
} {
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const siblings = children.get(span.parentSpanId) ?? [];
    siblings.push(span);
    children.set(span.parentSpanId, siblings);
  }
  const result = {
    modelCallIds: new Set<unknown>(),
    batchIds: new Set<unknown>(),
    toolCallIds: new Set<unknown>(),
  };
  const pending = [...(children.get(spanId) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const child = pending.pop();
    if (!child || visited.has(child.spanId)) continue;
    visited.add(child.spanId);
    const attributes = child.attributes ?? {};
    add(result.modelCallIds, attributes["agent.model.call.id"]);
    add(result.batchIds, attributes["agent.tool.batch.id"]);
    add(result.toolCallIds, attributes["agent.tool.call.id"]);
    pending.push(...(children.get(child.spanId) ?? []));
  }
  return result;
}

function inheritedAttribute(span: TraceSpan, spans: readonly TraceSpan[], key: string): unknown {
  const byId = new Map(spans.map((candidate) => [candidate.spanId, candidate]));
  let parentId = span.parentSpanId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return undefined;
    const value = parent.attributes?.[key];
    if (value !== undefined) return value;
    parentId = parent.parentSpanId;
  }
  return undefined;
}

function nodeInput(span: TraceSpan, records: readonly TraceReplayRecord[]): unknown {
  if (span.name === "agent.run") {
    return records.filter((record) => record.kind === "user.input").map(payloadOf);
  }
  if (span.name === "agent.turn" || span.name === "gen_ai.generate") {
    return payloadOf(records.find((record) => record.kind === "model.request.captured"));
  }
  if (span.name === "agent.context.prepare") {
    return records.filter((record) => record.kind === "context.progress").map(payloadOf);
  }
  if (span.name === "agent.tool.batch") {
    return payloadOf(records.find((record) => record.kind === "tool.batch.started"));
  }
  if (span.name === "agent.tool.call") {
    return payloadOf(records.find((record) => record.kind === "tool.call.started"))?.input;
  }
  return payloadOf(records.find((record) => record.kind.endsWith(".started"))) ?? null;
}

function nodeOutput(
  span: TraceSpan,
  records: readonly TraceReplayRecord[],
  replay: readonly TraceReplayRecord[],
  run: TraceRun | null,
): unknown {
  if (span.name === "agent.run") {
    const finalCall = [...records]
      .reverse()
      .find((record) => record.kind === "agent.final_response")?.correlation?.modelCallId;
    return {
      response: aggregateModelOutput(
        replay.filter((record) => record.correlation?.modelCallId === finalCall),
      ),
      summary: run?.summary ?? null,
    };
  }
  if (span.name === "agent.turn" || span.name === "gen_ai.generate") {
    return aggregateModelOutput(records);
  }
  if (span.name === "agent.context.prepare") {
    return payloadOf([...records].reverse().find((record) => record.kind === "context.prepared"));
  }
  if (span.name === "agent.tool.batch") {
    return payloadOf([...records].reverse().find((record) => record.kind !== "tool.batch.started"));
  }
  if (span.name === "agent.tool.call") {
    return payloadOf([...records].reverse().find((record) => record.kind !== "tool.call.started"));
  }
  return (
    payloadOf([...records].reverse().find((record) => !record.kind.endsWith(".started"))) ?? null
  );
}

function aggregateModelOutput(records: readonly TraceReplayRecord[]): Record<string, unknown> {
  const text = records
    .filter((record) => record.kind === "model.text.delta")
    .map((record) => payloadOf(record)?.event?.delta ?? "")
    .join("");
  const thinking = records
    .filter((record) => record.kind === "model.thinking.completed")
    .map((record) => payloadOf(record)?.event?.content)
    .filter(Boolean);
  const completion = payloadOf(
    [...records]
      .reverse()
      .find((record) =>
        ["model.completed", "model.failed", "model.cancelled"].includes(record.kind),
      ),
  );
  return {
    ...(text ? { text } : {}),
    ...(thinking.length ? { thinking } : {}),
    ...(completion ? { completion } : {}),
  };
}

function payloadOf(record: TraceReplayRecord | undefined): TraceReplayRecord["payload"] | null {
  if (!record) return null;
  return record.resolvedPayload ?? record.payload ?? record.payloadRef ?? null;
}

function add(set: Set<unknown>, value: unknown): void {
  if (value !== undefined && value !== null) set.add(value);
}

function contextEvent(
  payload: TraceReplayRecord["payload"],
): import("./contracts.js").ContextProgressEvent | undefined {
  return payload?.event?.event;
}
