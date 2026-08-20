import type { SpanPort, TraceStatus } from "../index";

export function completeSpan(span: SpanPort, status: TraceStatus): void {
  span.setStatus(status);
  span.end();
}

export function failSpan(span: SpanPort, error: unknown, status: TraceStatus = "error"): void {
  span.recordError(error);
  span.setStatus(status);
  span.end();
}
