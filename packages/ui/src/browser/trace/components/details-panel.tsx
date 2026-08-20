import {
  CornerDownRight,
  Sparkles,
  Wrench,
  CircleCheck,
  Layers3,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import type {
  DisplayNode,
  FlattenedDisplayNode,
  NodeDetails,
  TraceReplayRecord,
  TraceRun,
  TraceSpan,
} from "../model/contracts.js";
import {
  displayNodeDetails,
  formatDuration,
  overviewMetricRows,
  relatedToolNodes,
  spanPresentation,
} from "../model/view-model.js";
import { SectionHeader } from "./ui.js";

const ValueSection = lazy(() =>
  import("./formatted-value.js").then(({ ValueSection: component }) => ({ default: component })),
);

type FormatMode = "formatted" | "json";

export function DetailsPanel({
  node,
  details,
  spans,
  replay,
  run,
  loading,
  highlightedId,
}: {
  readonly node: DisplayNode | null;
  readonly details: NodeDetails | null;
  readonly spans: readonly TraceSpan[];
  readonly replay: readonly TraceReplayRecord[];
  readonly run: TraceRun | null;
  readonly loading: boolean;
  readonly highlightedId: string | null;
}) {
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [formats, setFormats] = useState<Map<string, FormatMode>>(new Map());
  const setFormat = (key: string, mode: FormatMode) =>
    setFormats((current) => new Map(current).set(key, mode));
  if (!node || !details)
    return (
      <aside className="details-panel">
        <div className="selection-heading">
          <div className="selection-copy">
            <div className="selection-title">
              <h2>{loading ? "Loading trace" : "Select an operation"}</h2>
            </div>
            <p className="selection-meta">
              {loading
                ? "Preparing the captured run details."
                : "Choose a Waterfall row to inspect its data."}
            </p>
          </div>
        </div>
        <div className="detail-content empty-state">
          <div className="detail-empty-state">
            <strong>{loading ? "Loading captured data…" : "Nothing selected"}</strong>
            <span>
              {loading
                ? "This will update as soon as the trace is ready."
                : "Select an operation on the left to inspect its input, output, and attributes."}
            </span>
          </div>
        </div>
      </aside>
    );
  const presentation = spanPresentation(node.span);
  const Icon = iconFor(presentation.kind);
  return (
    <aside className="details-panel">
      <div
        className={`selection-heading${highlightedId === node.span.spanId ? " linked-highlight" : ""}`}
      >
        <span className={`selection-icon kind-${presentation.kind}`}>
          <Icon />
        </span>
        <div className="selection-copy">
          <div className="selection-title">
            <h2>{presentation.label}</h2>
            <span className={`status-chip ${presentation.statusTone}`}>
              {capitalize(node.span.status)}
            </span>
          </div>
          <p className="selection-meta">{selectionMeta(node.span)}</p>
        </div>
      </div>
      <Tabs.Root className="detail-tabs-root" defaultValue="overview">
        <Tabs.List className="detail-tabs" aria-label="Operation details">
          {[
            ["overview", "Overview"],
            ["input", "Input"],
            ["output", "Output"],
            ["attributes", "Attributes"],
          ].map(([value, label]) => (
            <Tabs.Trigger key={value} className="detail-tab" value={value}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content className="detail-content" value="overview">
          <Overview
            node={node}
            spans={spans}
            replay={replay}
            run={run}
            formats={formats}
            onFormatChange={setFormat}
            expandedToolIds={expandedToolIds}
            highlightedId={highlightedId}
            onToolExpanded={(spanId, expanded) =>
              setExpandedToolIds((current) => {
                const next = new Set(current);
                if (expanded) next.add(spanId);
                else next.delete(spanId);
                return next;
              })
            }
          />
        </Tabs.Content>
        <Tabs.Content className="detail-content" value="input">
          <ScopedValueSection
            title="Input"
            value={details.input}
            formatKey={`${node.span.spanId}:input`}
            formats={formats}
            onFormatChange={setFormat}
          />
        </Tabs.Content>
        <Tabs.Content className="detail-content" value="output">
          <ScopedValueSection
            title="Output"
            value={details.output}
            formatKey={`${node.span.spanId}:output`}
            formats={formats}
            onFormatChange={setFormat}
          />
        </Tabs.Content>
        <Tabs.Content className="detail-content" value="attributes">
          <ScopedValueSection
            title="Attributes"
            value={details.attributes}
            formatKey={`${node.span.spanId}:attributes`}
            formats={formats}
            onFormatChange={setFormat}
          />
          <ScopedValueSection
            title="Span events"
            value={details.spanEvents}
            formatKey={`${node.span.spanId}:span-events`}
            formats={formats}
            onFormatChange={setFormat}
          />
          <ScopedValueSection
            title="Replay events"
            value={details.replayEvents}
            formatKey={`${node.span.spanId}:replay-events`}
            formats={formats}
            onFormatChange={setFormat}
          />
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}

function DeferredValueSection({
  title,
  value,
  mode,
  onModeChange,
}: {
  readonly title: string;
  readonly value: unknown;
  readonly mode: FormatMode;
  readonly onModeChange: (mode: FormatMode) => void;
}) {
  return (
    <Suspense fallback={<div className="empty-value">Formatting captured data…</div>}>
      <ValueSection title={title} value={value} mode={mode} onModeChange={onModeChange} />
    </Suspense>
  );
}

function ScopedValueSection({
  formatKey,
  formats,
  onFormatChange,
  ...section
}: {
  readonly title: string;
  readonly value: unknown;
  readonly formatKey: string;
  readonly formats: ReadonlyMap<string, FormatMode>;
  readonly onFormatChange: (key: string, mode: FormatMode) => void;
}) {
  return (
    <DeferredValueSection
      {...section}
      mode={formats.get(formatKey) ?? "formatted"}
      onModeChange={(mode) => onFormatChange(formatKey, mode)}
    />
  );
}

function Overview({
  node,
  spans,
  replay,
  run,
  formats,
  onFormatChange,
  expandedToolIds,
  highlightedId,
  onToolExpanded,
}: {
  readonly node: DisplayNode;
  readonly spans: readonly TraceSpan[];
  readonly replay: readonly TraceReplayRecord[];
  readonly run: TraceRun | null;
  readonly formats: ReadonlyMap<string, FormatMode>;
  readonly onFormatChange: (key: string, mode: FormatMode) => void;
  readonly expandedToolIds: ReadonlySet<string>;
  readonly highlightedId: string | null;
  readonly onToolExpanded: (spanId: string, expanded: boolean) => void;
}) {
  const tools = relatedToolNodes(node, spans, replay);
  return (
    <>
      <section className="detail-section overview-summary-section">
        <SectionHeader title="Summary" />
        <dl className="overview-summary">
          {overviewMetricRows(node).map(([label, value, tone]) => (
            <Metric key={label} label={label} value={value} tone={tone} />
          ))}
        </dl>
      </section>
      {tools.length > 0 && (
        <section className="tool-details">
          <SectionHeader title="Tools" className="tool-details-heading">
            <span>{tools.length} calls</span>
          </SectionHeader>
          <div className="tool-details-list">
            {tools.map((tool) => (
              <ToolCard
                key={tool.span.spanId}
                node={tool}
                details={displayNodeDetails(tool, spans, replay, run)}
                formats={formats}
                onFormatChange={onFormatChange}
                expanded={expandedToolIds.has(tool.span.spanId)}
                highlighted={highlightedId === tool.span.spanId}
                onExpanded={onToolExpanded}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly tone?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={tone}>{value}</dd>
    </div>
  );
}

function ToolCard({
  node,
  details,
  formats,
  onFormatChange,
  expanded,
  highlighted,
  onExpanded,
}: {
  readonly node: FlattenedDisplayNode;
  readonly details: NodeDetails;
  readonly formats: ReadonlyMap<string, FormatMode>;
  readonly onFormatChange: (key: string, mode: FormatMode) => void;
  readonly expanded: boolean;
  readonly highlighted: boolean;
  readonly onExpanded: (spanId: string, expanded: boolean) => void;
}) {
  const presentation = spanPresentation(node.span);
  const duration = (node.span.completedAt ?? node.span.startedAt) - node.span.startedAt;
  const phaseText = node.phases
    .map(
      ({ span }) =>
        `${capitalize(span.name.split(".").at(-1) ?? "phase")} ${formatDuration((span.completedAt ?? span.startedAt) - span.startedAt)}`,
    )
    .join(" · ");
  return (
    <details
      className={`tool-detail-card${highlighted ? " linked-highlight" : ""}`}
      open={expanded}
      onToggle={(event) => onExpanded(node.span.spanId, event.currentTarget.open)}
    >
      <summary className="tool-detail-card-summary">
        <span className="tool-detail-card-icon">
          <Wrench />
        </span>
        <span className="tool-detail-card-copy">
          <strong>{presentation.label}</strong>
          <span className="tool-detail-card-meta">
            {formatDuration(duration)}
            {phaseText ? ` · ${phaseText}` : ""}
          </span>
        </span>
      </summary>
      <div className="tool-detail-card-body">
        <ScopedValueSection
          title="Input"
          value={details.input}
          formatKey={`tool:${node.span.spanId}:input`}
          formats={formats}
          onFormatChange={onFormatChange}
        />
        <ScopedValueSection
          title="Output"
          value={details.output}
          formatKey={`tool:${node.span.spanId}:output`}
          formats={formats}
          onFormatChange={onFormatChange}
        />
        <ScopedValueSection
          title="Attributes"
          value={details.attributes}
          formatKey={`tool:${node.span.spanId}:attributes`}
          formats={formats}
          onFormatChange={onFormatChange}
        />
      </div>
    </details>
  );
}

function iconFor(kind: string): LucideIcon {
  return (
    (
      {
        turn: CornerDownRight,
        model: Sparkles,
        tool: Wrench,
        run: CircleCheck,
        compaction: Layers3,
      } as Record<string, LucideIcon>
    )[kind] ?? CircleCheck
  );
}
function selectionMeta(span: TraceSpan): string {
  const input = span.attributes["gen_ai.usage.input_tokens"];
  const output = span.attributes["gen_ai.usage.output_tokens"];
  const tokens =
    input === undefined && output === undefined
      ? []
      : [`${Number(input ?? 0) + Number(output ?? 0)} tokens`];
  return [
    span.completedAt ? formatDuration(span.completedAt - span.startedAt) : "active",
    ...tokens,
    `started ${formatClock(span.startedAt)}`,
    shortId(span.spanId),
  ].join(" · ");
}
function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}
function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
