export type TraceStatus =
  "running" | "ok" | "completed" | "error" | "denied" | "timed_out" | "cancelled" | string;

export interface TraceSpan {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: number;
  completedAt?: number;
  status: TraceStatus;
  attributes: Record<string, unknown>;
  events: unknown[];
  error?: unknown;
  readonly synthetic?: boolean;
}

export interface TraceReplayRecord {
  readonly seq: number;
  readonly timestamp: number;
  readonly kind: string;
  readonly correlation?: {
    readonly traceId?: string;
    readonly modelCallId?: string;
    readonly batchId?: string;
    readonly toolCallId?: string;
  };
  readonly payload?: TracePayload;
  readonly payloadRef?: TracePayload & { readonly payloadId?: string; readonly parts?: number };
  resolvedPayload?: TracePayload;
  payloadLoading?: boolean;
}

export interface TracePayload {
  readonly turn?: number;
  readonly input?: unknown;
  readonly event?: TraceEventEnvelope;
  readonly [key: string]: unknown;
}

export interface TraceEventEnvelope {
  readonly delta?: string;
  readonly content?: unknown;
  readonly report?: CacheReport;
  readonly event?: ContextProgressEvent;
  readonly manifest?: ContextManifest;
  readonly [key: string]: unknown;
}

export interface CacheReport {
  readonly modelCallId?: string;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly cacheHitRate?: number | null;
  readonly lifecycle?: unknown;
  readonly requestedRetention?: unknown;
  readonly appliedRetention?: unknown;
  readonly outcome?: unknown;
  readonly reason?: unknown;
  readonly [key: string]: unknown;
}

export interface ContextProgressEvent {
  readonly type?: string;
  readonly compressionId?: string;
  readonly modelCallId?: string;
  readonly beforeTokens?: number;
  readonly cancelled?: boolean;
  readonly reason?: unknown;
  readonly report?: ContextReport;
}

export interface ContextReport {
  readonly beforeTokens?: number;
  readonly afterTokens?: number;
  readonly tokenDelta?: number;
  readonly reductionRatio?: number;
  readonly durationMs?: number;
  readonly operations?: unknown;
  readonly trigger?: unknown;
}

export interface ContextManifest {
  readonly modelCallId?: string;
  readonly checkpoint?: {
    readonly action?: string;
    readonly checkpointId?: string;
    readonly coveredMessageCount?: number;
  };
}

export interface TraceRun {
  readonly runId: string;
  readonly sessionId?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status: TraceStatus;
  readonly summary?: {
    readonly capture?: { readonly degraded?: boolean; readonly droppedRecords?: number };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface TraceSession {
  readonly sessionId: string;
  readonly latestStartedAt: number;
  readonly runs: number;
}

export type SpanRecord =
  | {
      readonly kind: "span.started";
      readonly identity: { readonly spanId: string; readonly parentSpanId?: string };
      readonly name: string;
      readonly timestamp: number;
      readonly attributes: Record<string, unknown>;
      readonly seq: number;
    }
  | {
      readonly kind: "span.updated";
      readonly spanId: string;
      readonly attribute: { readonly key: string; readonly value: unknown };
      readonly seq: number;
    }
  | {
      readonly kind: "span.event";
      readonly spanId: string;
      readonly timestamp: number;
      readonly name: string;
      readonly attributes: Record<string, unknown>;
      readonly seq: number;
    }
  | {
      readonly kind: "span.completed";
      readonly spanId: string;
      readonly completedAt: number;
      readonly status: string;
      readonly error?: unknown;
      readonly seq: number;
    };

export interface SpanNode {
  readonly span: TraceSpan;
  readonly children: SpanNode[];
}

export interface DisplayMetrics {
  readonly tokens?: { readonly input: number; readonly output: number; readonly total: number };
  readonly cache?: {
    readonly readTokens: number;
    readonly writeTokens: number;
    readonly inputTokens: number;
    readonly hitRate: number | null;
    readonly lifecycle?: unknown;
    readonly requestedRetention?: unknown;
    readonly appliedRetention?: unknown;
    readonly outcome?: unknown;
    readonly reason?: unknown;
    readonly report: CacheReport;
  };
}

export interface DisplayNode {
  readonly span: TraceSpan;
  readonly children: DisplayNode[];
  readonly phases: SpanNode[];
  readonly metrics: DisplayMetrics;
  readonly replayRecords?: readonly TraceReplayRecord[];
}

export interface FlattenedDisplayNode extends DisplayNode {
  readonly depth: number;
}

export interface TraceTimeWindow {
  readonly fullStart: number;
  readonly fullFinish: number;
  readonly start: number;
  readonly finish: number;
  readonly focusedSpanId: string | null;
}

export interface NodeDetails {
  readonly input: unknown;
  readonly output: unknown;
  readonly attributes: Record<string, unknown>;
  readonly spanEvents: readonly unknown[];
  readonly replayEvents: readonly {
    readonly seq: number;
    readonly timestamp: number;
    readonly kind: string;
    readonly correlation?: TraceReplayRecord["correlation"];
  }[];
}
