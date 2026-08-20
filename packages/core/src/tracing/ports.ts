import type { ReplayEventInput, TraceAttributes, TraceSpanIdentity, TraceStatus } from "./types";

export interface SpanPort {
  readonly identity: TraceSpanIdentity;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: TraceAttributes): void;
  recordError(error: unknown): void;
  setStatus(status: TraceStatus): void;
  run<T>(operation: () => T): T;
  end(): void;
}

export interface TracerPort {
  startSpan(name: string, attributes?: TraceAttributes): SpanPort;
}

export interface ReplaySinkPort {
  record(event: ReplayEventInput): void;
}

export interface TraceControlPort {
  start(): void;
  stop(): void;
  status(): "off" | "on";
}
