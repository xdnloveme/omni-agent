import type { ReplaySinkPort, SpanPort, TraceControlPort, TracerPort } from "./ports";
import type { TraceAttributes, TraceRunIdentity, TraceStatus } from "./types";

const IDENTITY: TraceRunIdentity = {
  agentId: "noop",
  sessionId: "noop",
  runId: "noop",
  traceId: "noop",
};

export const NOOP_SPAN: SpanPort = {
  identity: { ...IDENTITY, spanId: "noop" },
  setAttribute() {},
  addEvent() {},
  recordError() {},
  setStatus(_status: TraceStatus) {},
  run<T>(operation: () => T): T {
    return operation();
  },
  end() {},
};

export const NOOP_TRACER: TracerPort = {
  startSpan(_name: string, _attributes?: TraceAttributes) {
    return NOOP_SPAN;
  },
};

export const NOOP_REPLAY_SINK: ReplaySinkPort = {
  record() {},
};

export const NOOP_TRACE_CONTROL: TraceControlPort = {
  start() {},
  stop() {},
  status() {
    return "off";
  },
};
