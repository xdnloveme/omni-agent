import type {
  CacheReport,
  DisplayMetrics,
  DisplayNode,
  FlattenedDisplayNode,
  SpanNode,
  TraceReplayRecord,
  TraceRun,
  TraceSpan,
} from "./contracts.js";
import {
  isTerminalError,
  numeric,
  spanDuration,
  spanPresentation,
} from "./view-model-presentation.js";

export { displayNodeDetails, nodeDetails } from "./view-model-details.js";
export {
  formatCompactNumber,
  formatDuration,
  spanPresentation,
} from "./view-model-presentation.js";
export {
  cachePresentation,
  overviewMetricRows,
  traceSummary,
  type CachePresentation,
  type OverviewMetricRow,
} from "./view-model-summary.js";
export { projectSpanInterval, traceWindow } from "./view-model-timeline.js";

/** Pure projections from trace transport records into browser presentation models. */
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
  return isTerminalError(span.status);
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

function contextEvent(
  payload: TraceReplayRecord["payload"],
): import("./contracts.js").ContextProgressEvent | undefined {
  return payload?.event?.event;
}

function payloadOf(record: TraceReplayRecord | undefined): TraceReplayRecord["payload"] | null {
  if (!record) return null;
  return record.resolvedPayload ?? record.payload ?? record.payloadRef ?? null;
}
