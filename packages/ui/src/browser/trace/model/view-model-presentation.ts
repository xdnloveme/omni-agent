import type { TraceSpan } from "./contracts.js";

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

export function isTerminalError(status: string): boolean {
  return TERMINAL_ERROR_STATUSES.has(status);
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

export function spanDuration(span: TraceSpan): number {
  return Math.max(0, (span.completedAt ?? span.startedAt) - span.startedAt);
}

export function numeric(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
