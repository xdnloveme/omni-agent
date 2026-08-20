import { useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import * as Tooltip from "@radix-ui/react-tooltip";
import { DetailsPanel } from "../components/details-panel.js";
import { ExecutionToolbar, Waterfall, type ViewMode } from "../components/waterfall.js";
import { TopBar } from "../components/top-bar.js";
import { usePayloadHydration } from "../hooks/use-payload-hydration.js";
import { useTraceData } from "../hooks/use-trace-data.js";
import type { DisplayNode } from "../model/contracts.js";
import {
  buildDisplayForest,
  captureHealth,
  criticalSpanIds,
  displayNodeDetails,
  filterDisplayForest,
  flattenSpanForest,
  focusedSpanForest,
  spanPresentation,
  traceSummary,
  traceWindow,
} from "../model/view-model.js";

export function TraceStudio() {
  const data = useTraceData();
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const forest = useMemo(
    () => buildDisplayForest(data.spans, data.replay, viewMode),
    [data.spans, data.replay, viewMode],
  );
  const allNodes = useMemo(() => flattenSpanForest(forest), [forest]);
  const nodeMap = useMemo(
    () => new Map(allNodes.map((node) => [node.span.spanId, node])),
    [allNodes],
  );
  const filtered = useMemo(() => filterDisplayForest(forest, filter), [forest, filter]);
  const focused = useMemo(() => focusedSpanForest(filtered, focusedId), [filtered, focusedId]);
  const rows = useMemo(() => flattenSpanForest(focused, collapsedIds), [focused, collapsedIds]);
  const summary = useMemo(() => traceSummary(forest), [forest]);
  const criticalIds = useMemo(() => criticalSpanIds(forest), [forest]);
  const window = useMemo(
    () => (data.spans.length ? traceWindow(data.spans, focusedId) : null),
    [data.spans, focusedId],
  );
  const selectedNode = selectedId ? (nodeMap.get(selectedId) ?? null) : null;
  const details = selectedNode
    ? displayNodeDetails(selectedNode, data.spans, data.replay, data.run)
    : null;
  const selectedSpan = selectedNode?.span;
  const focusedSpan = focusedId ? data.spans.find((span) => span.spanId === focusedId) : undefined;
  const canFocus = Boolean(
    focusedSpan || (selectedSpan && !selectedSpan.synthetic && selectedSpan.name !== "agent.run"),
  );
  const branchIds = useMemo(
    () =>
      new Set(allNodes.filter((node) => node.children.length > 0).map((node) => node.span.spanId)),
    [allNodes],
  );
  const health = captureHealth(data.run);
  usePayloadHydration({
    sessionId: data.sessionId,
    runId: data.runId,
    details,
    replay: data.replay,
    setReplay: data.setReplay,
  });

  useEffect(() => {
    setSelectedId(null);
    setFocusedId(null);
    setCollapsedIds(new Set());
    setFilter("all");
  }, [data.runId]);

  useEffect(() => {
    if (!allNodes.length) return;
    setSelectedId((current) =>
      current && nodeMap.has(current)
        ? current
        : (allNodes.find((node) => node.span.name === "agent.turn")?.span.spanId ??
          allNodes[0]?.span.spanId ??
          null),
    );
  }, [allNodes, nodeMap]);

  const toggleTree = () =>
    setCollapsedIds((current) => (current.size ? new Set() : new Set(branchIds)));
  const toggleNode = (id: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const focusSelection = () => {
    if (focusedId) setFocusedId(null);
    else if (selectedSpan && !selectedSpan.synthetic && selectedSpan.name !== "agent.run") {
      setFocusedId(selectedSpan.spanId);
      setCollapsedIds((current) => {
        const next = new Set(current);
        next.delete(selectedSpan.spanId);
        return next;
      });
    }
  };

  return (
    <Tooltip.Provider skipDelayDuration={150}>
      <TopBar
        agent={data.agent}
        sessions={data.sessions}
        runs={data.runs}
        sessionId={data.sessionId}
        runId={data.runId}
        run={data.run}
        onSession={data.selectSession}
        onRun={data.selectRun}
      />
      {health && <div className="capture-warning">{health.message}</div>}
      {data.error && <div className="capture-warning">{data.error}</div>}
      <Group
        className="studio"
        orientation="horizontal"
        defaultLayout={{ waterfall: 47, details: 53 }}
      >
        <Panel id="waterfall" minSize="360px">
          <section className="waterfall-panel">
            <ExecutionToolbar
              summary={summary}
              turns={data.spans.filter((span) => span.name === "agent.turn").length}
              filter={filter}
              viewMode={viewMode}
              focusedLabel={focusedSpan ? spanPresentation(focusedSpan).label : null}
              canFocus={canFocus}
              collapsed={collapsedIds.size > 0}
              hasTree={branchIds.size > 0}
              onFilter={(value) => {
                setFilter(value);
                setFocusedId(null);
              }}
              onViewMode={setViewMode}
              onFocus={focusSelection}
              onToggleTree={toggleTree}
            />
            <Waterfall
              rows={rows}
              spans={data.spans}
              window={window}
              viewMode={viewMode}
              selectedId={selectedId}
              criticalIds={criticalIds}
              collapsedIds={collapsedIds}
              onSelect={setSelectedId}
              onFocus={(id) => {
                setSelectedId(id);
                setFocusedId(id);
                setCollapsedIds((current) => {
                  const next = new Set(current);
                  next.delete(id);
                  return next;
                });
              }}
              onToggle={toggleNode}
            />
          </section>
        </Panel>
        <Separator className="split-handle" />
        <Panel id="details" minSize="420px">
          <div className="details-panel-wrap">
            <DetailsPanel
              node={selectedNode as DisplayNode | null}
              details={details}
              spans={data.spans}
              replay={data.replay}
              run={data.run}
            />
          </div>
        </Panel>
      </Group>
    </Tooltip.Provider>
  );
}
