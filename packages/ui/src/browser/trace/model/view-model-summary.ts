import type { DisplayMetrics, DisplayNode } from "./contracts.js";
import {
  capitalize,
  formatCompactNumber,
  formatDuration,
  formatPercent,
  numeric,
  spanDuration,
  spanPresentation,
} from "./view-model-presentation.js";

export function traceSummary(roots: readonly DisplayNode[]): {
  readonly models: number;
  readonly tools: number;
  readonly compactions: number;
  readonly errors: number;
  readonly tokenUsage: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheHitRate: number | null;
  readonly accessMs: number;
} {
  const semantic = allNodes(roots).filter(
    ({ span }) => !["agent.run", "agent.turn"].includes(span.name),
  );
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
        .filter(({ span }) => span.name === "agent.tool.access")
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
    accessMs: waitingMs,
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

function allNodes(roots: readonly DisplayNode[]): DisplayNode[] {
  const nodes: DisplayNode[] = [];
  const visit = (node: DisplayNode): void => {
    nodes.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return nodes;
}
