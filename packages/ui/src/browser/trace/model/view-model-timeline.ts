import type { TraceSpan, TraceTimeWindow } from "./contracts.js";

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
