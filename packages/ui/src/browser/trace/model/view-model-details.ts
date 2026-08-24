import type {
  DisplayNode,
  NodeDetails,
  SpanNode,
  TraceReplayRecord,
  TraceRun,
  TraceSpan,
} from "./contracts.js";

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
    case "agent.tool.access":
      return kind.startsWith("tool.access.");
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
