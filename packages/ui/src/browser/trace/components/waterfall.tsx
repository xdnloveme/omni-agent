import {
  Bot,
  Boxes,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleCheck,
  CornerDownRight,
  Database,
  Focus,
  Gauge,
  Info,
  Layers3,
  ListTree,
  Rows3,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type {
  DisplayNode,
  FlattenedDisplayNode,
  TraceSpan,
  TraceTimeWindow,
} from "../model/contracts.js";
import {
  cachePresentation,
  formatDuration,
  overviewMetricRows,
  projectSpanInterval,
  spanPresentation,
} from "../model/view-model.js";
import { Hint, IconButton, SelectField } from "./ui.js";

export type ViewMode = "overview" | "detailed";

const FILTER_OPTIONS = [
  ["all", "All operations"],
  ["models", "Models"],
  ["tools", "Tools"],
  ["context", "Context"],
  ["authorization", "Authorization"],
  ["cache", "Cache"],
  ["slow", "Slow"],
  ["errors", "Errors"],
].map(([value, label]) => ({ value, label }));

export function ExecutionToolbar({
  summary,
  turns,
  filter,
  viewMode,
  focusedLabel,
  canFocus,
  collapsed,
  hasTree,
  onFilter,
  onViewMode,
  onFocus,
  onToggleTree,
}: {
  readonly summary: {
    readonly models: number;
    readonly tools: number;
    readonly tokenUsage: number;
    readonly authorizationMs: number;
    readonly errors: number;
    readonly compactions: number;
    readonly cacheHitRate: number | null;
  };
  readonly turns: number;
  readonly filter: string;
  readonly viewMode: ViewMode;
  readonly focusedLabel: string | null;
  readonly canFocus: boolean;
  readonly collapsed: boolean;
  readonly hasTree: boolean;
  readonly onFilter: (filter: string) => void;
  readonly onViewMode: (mode: ViewMode) => void;
  readonly onFocus: () => void;
  readonly onToggleTree: () => void;
}) {
  const summaryText = [
    `${turns} ${turns === 1 ? "turn" : "turns"}`,
    `${summary.models} ${summary.models === 1 ? "model" : "models"}`,
    `${summary.tools} ${summary.tools === 1 ? "tool" : "tools"}`,
    `${compact(summary.tokenUsage)} tokens`,
    ...(summary.cacheHitRate === null ? [] : [`cache ${formatPercent(summary.cacheHitRate)}`]),
    ...(summary.authorizationMs > 0
      ? [`authorization ${formatDuration(summary.authorizationMs)}`]
      : []),
    ...(summary.compactions > 0 ? [`${summary.compactions} compacted`] : []),
    ...(focusedLabel ? [`focused ${focusedLabel}`] : []),
    ...(summary.errors > 0 ? [`${summary.errors} errors`] : []),
  ].join(" · ");
  return (
    <div className="execution-toolbar">
      <div className="execution-scope">
        <span className="execution-title">Execution</span>
        <span className="execution-scope-divider">/</span>
        <div className="execution-filter">
          <SelectField
            label="Filter operations"
            value={filter}
            placeholder="All operations"
            quiet
            options={FILTER_OPTIONS}
            onValueChange={onFilter}
          />
        </div>
      </div>
      <div className="execution-summary" aria-label={summaryText}>
        <Metric icon={CornerDownRight} value={turns} label="turns" />
        <Metric icon={Wrench} value={summary.tools} label="tools" />
        <Metric icon={Gauge} value={compact(summary.tokenUsage)} label="tokens" />
        {summary.errors > 0 && <Metric icon={Info} value={summary.errors} label="errors" />}
        <Hint label={summaryText}>
          <span className="execution-summary-info" tabIndex={0}>
            <Info aria-hidden="true" />
          </span>
        </Hint>
      </div>
      <div className="execution-actions">
        <span className="view-switch">
          <Hint label="Compact trace view">
            <button
              type="button"
              className={viewMode === "overview" ? "active" : ""}
              aria-label="Compact trace view"
              onClick={() => onViewMode("overview")}
            >
              <Rows3 />
            </button>
          </Hint>
          <Hint label="Full trace view">
            <button
              type="button"
              className={viewMode === "detailed" ? "active" : ""}
              aria-label="Full trace view"
              onClick={() => onViewMode("detailed")}
            >
              <ListTree />
            </button>
          </Hint>
        </span>
        <IconButton
          icon={Focus}
          label={
            focusedLabel
              ? `Exit focused view: ${focusedLabel}`
              : "Focus timeline on selected operation"
          }
          active={Boolean(focusedLabel)}
          disabled={!canFocus}
          onClick={onFocus}
        />
        <IconButton
          icon={collapsed ? ChevronsUpDown : ChevronsDownUp}
          label={collapsed ? "Expand all operations" : "Collapse all operations"}
          disabled={!hasTree}
          onClick={onToggleTree}
        />
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  value,
  label,
}: {
  readonly icon: LucideIcon;
  readonly value: string | number;
  readonly label: string;
}) {
  return (
    <span className="execution-metric">
      <Icon aria-hidden="true" />
      <span>
        {value} {label}
      </span>
    </span>
  );
}

export function Waterfall({
  rows,
  spans,
  window,
  viewMode,
  selectedId,
  criticalIds,
  collapsedIds,
  onSelect,
  onFocus,
  onToggle,
}: {
  readonly rows: readonly FlattenedDisplayNode[];
  readonly spans: readonly TraceSpan[];
  readonly window: TraceTimeWindow | null;
  readonly viewMode: ViewMode;
  readonly selectedId: string | null;
  readonly criticalIds: ReadonlySet<string>;
  readonly collapsedIds: ReadonlySet<string>;
  readonly onSelect: (id: string) => void;
  readonly onFocus: (id: string) => void;
  readonly onToggle: (id: string) => void;
}) {
  return (
    <>
      <div className="waterfall-columns">
        <span>Operation</span>
        <TimelineAxis spans={spans} window={window} />
        <span>Duration</span>
      </div>
      <div className={`waterfall mode-${viewMode}${rows.length ? "" : " empty-state"}`}>
        {!rows.length && "No trace operations match this view."}
        {window &&
          rows.map((row) => (
            <WaterfallRow
              key={row.span.spanId}
              row={row}
              window={window}
              selected={row.span.spanId === selectedId}
              critical={criticalIds.has(row.span.spanId)}
              collapsed={collapsedIds.has(row.span.spanId)}
              overview={viewMode === "overview"}
              onSelect={onSelect}
              onFocus={onFocus}
              onToggle={onToggle}
            />
          ))}
      </div>
    </>
  );
}

function TimelineAxis({
  spans,
  window,
}: {
  readonly spans: readonly TraceSpan[];
  readonly window: TraceTimeWindow | null;
}) {
  if (!window) return <span className="timeline-axis" />;
  const total = Math.max(1, window.fullFinish - window.fullStart);
  return (
    <span className="timeline-axis">
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <span key={ratio} className="axis-tick" style={{ left: `${ratio * 100}%` }}>
          {formatDuration(window.start - window.fullStart + (window.finish - window.start) * ratio)}
        </span>
      ))}
      <span className="timeline-overview">
        {spans
          .filter((span) => span.name === "agent.turn")
          .map((turn) => (
            <span
              key={turn.spanId}
              className="overview-segment"
              style={{
                left: `${((turn.startedAt - window.fullStart) / total) * 100}%`,
                width: `${(((turn.completedAt ?? Date.now()) - turn.startedAt) / total) * 100}%`,
              }}
            />
          ))}
        <span
          className="overview-viewport"
          style={{
            left: `${((window.start - window.fullStart) / total) * 100}%`,
            width: `${((window.finish - window.start) / total) * 100}%`,
          }}
        />
      </span>
    </span>
  );
}

function WaterfallRow({
  row,
  window,
  selected,
  critical,
  collapsed,
  overview,
  onSelect,
  onFocus,
  onToggle,
}: {
  readonly row: FlattenedDisplayNode;
  readonly window: TraceTimeWindow;
  readonly selected: boolean;
  readonly critical: boolean;
  readonly collapsed: boolean;
  readonly overview: boolean;
  readonly onSelect: (id: string) => void;
  readonly onFocus: (id: string) => void;
  readonly onToggle: (id: string) => void;
}) {
  const { span, children, depth, phases } = row;
  const presentation = spanPresentation(span);
  const Icon = iconFor(presentation.kind);
  const interval = projectSpanInterval(span, window);
  const duration = span.completedAt ? formatDuration(span.completedAt - span.startedAt) : "active";
  const style = { "--depth": depth } as CSSProperties;
  return (
    <div
      className={`waterfall-row row-kind-${presentation.kind}${selected ? " selected" : ""}${critical ? " critical" : ""}`}
      style={style}
    >
      <button
        type="button"
        className={`tree-toggle${collapsed ? " collapsed" : ""}`}
        disabled={!children.length}
        aria-label={collapsed ? "Expand children" : "Collapse children"}
        onClick={() => onToggle(span.spanId)}
      >
        {children.length > 0 && <ChevronDown />}
      </button>
      <Tooltip.Root delayDuration={250}>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="row-select"
            onClick={() => onSelect(span.spanId)}
            onDoubleClick={() => onFocus(span.spanId)}
          >
            <span className="operation-cell">
              <span className={`operation-icon kind-${presentation.kind}`}>
                <Icon />
              </span>
              <span
                className={`operation-name${presentation.statusTone === "error" ? " error" : ""}`}
              >
                {presentation.label}
              </span>
              <span className="operation-kind">{operationMeta(row)}</span>
            </span>
            <span className="timeline-track">
              {interval && (
                <span
                  className={`timeline-bar kind-${presentation.kind} ${presentation.statusTone}${interval.clippedStart ? " clipped-start" : ""}${interval.clippedFinish ? " clipped-finish" : ""}${interval.left >= 100 ? " at-end" : ""}`}
                  style={{ left: `${interval.left}%`, width: `${interval.width}%` }}
                  title={spanTimingLabel(span, presentation.label, window.fullStart)}
                />
              )}
              {overview &&
                phases.map(({ span: phase }) => (
                  <Phase key={phase.spanId} span={phase} window={window} />
                ))}
            </span>
            <span className={`duration-cell ${presentation.statusTone}`}>{duration}</span>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="node-overview"
            side="right"
            sideOffset={10}
            collisionPadding={12}
          >
            <NodeOverview node={row} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </div>
  );
}

function Phase({ span, window }: { readonly span: TraceSpan; readonly window: TraceTimeWindow }) {
  const interval = projectSpanInterval(span, window);
  if (!interval) return null;
  const phase = span.name.split(".").at(-1) ?? "execution";
  const label = `${capitalize(phase)} · ${formatDuration((span.completedAt ?? span.startedAt) - span.startedAt)}`;
  return (
    <span
      className={`tool-phase phase-${phase} ${spanPresentation(span).statusTone}`}
      style={{ left: `${interval.left}%`, width: `${interval.width}%` }}
      title={label}
      aria-label={label}
    />
  );
}

function NodeOverview({ node }: { readonly node: DisplayNode }) {
  const presentation = spanPresentation(node.span);
  const Icon = iconFor(presentation.kind);
  return (
    <>
      <div className="node-overview-header">
        <span className={`operation-icon kind-${presentation.kind}`}>
          <Icon />
        </span>
        <span className="node-overview-heading">
          <strong>{presentation.label}</strong>
          <span>
            {capitalize(node.span.status)} ·{" "}
            {formatDuration((node.span.completedAt ?? node.span.startedAt) - node.span.startedAt)}
          </span>
        </span>
      </div>
      <dl className="node-overview-metrics">
        {overviewMetricRows(node).map(([label, value, tone]) => (
          <div className="node-overview-metric" key={label}>
            <dt>{label}</dt>
            <dd className={tone}>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function operationMeta(node: DisplayNode) {
  const presentation = spanPresentation(node.span);
  if (presentation.kind === "model") {
    const cache = node.metrics.cache;
    const cacheView = cache ? cachePresentation(cache) : null;
    return (
      <>
        {node.metrics.tokens?.total ? `MODEL · ${compact(node.metrics.tokens.total)} TOK` : "MODEL"}
        {cacheView?.visible && (
          <span className={`metric-pill cache ${cacheView.tone}`} title={cacheView.tooltip}>
            {cacheView.label}
          </span>
        )}
      </>
    );
  }
  if (presentation.kind === "batch") {
    const calls = Number(node.span.attributes["agent.tool.batch.size"] ?? node.children.length);
    const failures = node.children.filter(
      ({ span }) => spanPresentation(span).statusTone === "error",
    ).length;
    const running = node.children.filter(
      ({ span }) => spanPresentation(span).statusTone === "running",
    ).length;
    return `${calls} CALLS · ${failures ? `${failures} ERROR` : running ? `${running} ACTIVE` : "OK"}`;
  }
  if (presentation.kind === "compaction") {
    const before = Number(node.span.attributes["context.before_tokens"] ?? 0);
    const after = Number(node.span.attributes["context.after_tokens"] ?? 0);
    const reduction = node.span.attributes["context.reduction_ratio"];
    return before
      ? `${compact(before)} → ${compact(after)} TOK${typeof reduction === "number" ? ` · −${formatPercent(reduction)}` : ""}`
      : "CONTEXT";
  }
  if (presentation.kind === "checkpoint") {
    return `CONTEXT · ${String(node.span.attributes["context.operation"] ?? "checkpoint").toUpperCase()}`;
  }
  return presentation.kind.toUpperCase();
}

function iconFor(kind: string): LucideIcon {
  return (
    (
      {
        run: CircleCheck,
        turn: CornerDownRight,
        model: Sparkles,
        tool: Wrench,
        batch: Boxes,
        guard: ShieldCheck,
        execution: Terminal,
        context: Layers3,
        session: Database,
        compaction: Layers3,
        checkpoint: Database,
        finish: CircleCheck,
      } as Record<string, LucideIcon>
    )[kind] ?? Bot
  );
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function spanTimingLabel(span: TraceSpan, label: string, traceStart: number): string {
  return [
    label,
    `Start +${formatDuration(span.startedAt - traceStart)}`,
    `Duration ${span.completedAt ? formatDuration(span.completedAt - span.startedAt) : "active"}`,
    `Status ${capitalize(span.status)}`,
  ].join("\n");
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
