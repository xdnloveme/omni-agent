import { Activity } from "lucide-react";
import type { AgentSummary } from "../data/trace-client.js";
import type { TraceRun, TraceSession } from "../model/contracts.js";
import { formatDuration } from "../model/view-model.js";
import { SelectField } from "./ui.js";

export function TopBar({
  agent,
  sessions,
  runs,
  sessionId,
  runId,
  run,
  onSession,
  onRun,
}: {
  readonly agent: AgentSummary | null;
  readonly sessions: readonly TraceSession[];
  readonly runs: readonly TraceRun[];
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly run: TraceRun | null;
  readonly onSession: (id: string | null) => void;
  readonly onRun: (id: string | null) => void;
}) {
  const tone =
    run?.status === "running"
      ? "running"
      : run?.status === "completed" || run?.status === "ok"
        ? "success"
        : run
          ? "error"
          : "";
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Activity aria-hidden="true" />
        </span>
        <h1>Trace Studio</h1>
        <span className="agent-chip">
          {agent ? `${agent.agentId} · ${formatBytes(agent.diskUsage)}` : "Loading…"}
        </span>
      </div>
      <div className="trace-picker">
        <SelectField
          label="Session"
          value={sessionId}
          placeholder="No sessions"
          options={sessions.map((session) => ({
            value: session.sessionId,
            label: formatSession(session),
          }))}
          disabled={!sessions.length}
          onValueChange={(value) => onSession(value)}
        />
        <SelectField
          label="Run"
          value={runId}
          placeholder="No runs"
          options={runs.map((item, index) => ({
            value: item.runId,
            label: `Run ${runs.length - index} · ${formatClock(item.startedAt)} · ${item.status}`,
          }))}
          disabled={!runs.length}
          onValueChange={(value) => onRun(value)}
        />
      </div>
      <span className={`status-chip ${tone}`}>
        {run
          ? `${capitalize(run.status)} · ${formatDuration((run.completedAt ?? Date.now()) - run.startedAt)}`
          : "No run"}
      </span>
      <span className="agent-chip" title={run?.assembly?.digest}>
        {run?.assembly
          ? `${run.assembly.packageName}@${run.assembly.packageVersion} · ${run.assembly.model.modelId} · ${run.assembly.digest.slice(0, 15)}`
          : "Assembly unavailable"}
      </span>
    </header>
  );
}

function formatSession(session: TraceSession): string {
  return `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(session.latestStartedAt)} · ${session.runs} ${session.runs === 1 ? "run" : "runs"}`;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
