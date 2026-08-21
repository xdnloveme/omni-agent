import type {
  ReplayCorrelation,
  TraceAttributes,
  TraceRunIdentity,
  TraceStatus,
} from "@omni-agent/core";
import type { AgentAssemblySnapshot } from "../assembly/contracts";

export const LOCAL_TRACE_SCHEMA_VERSION = 1;

export interface TraceRunManifest extends TraceRunIdentity {
  readonly version: 1;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status: "running" | "completed" | "error" | "cancelled";
  readonly assembly?: AgentAssemblySnapshot;
  readonly summary?: {
    readonly usage?: unknown;
    readonly failure?: unknown;
    readonly capture?: {
      readonly degraded: true;
      readonly droppedRecords: number;
    };
  };
}

export type SpanLifecycleRecord =
  | {
      readonly version: 1;
      readonly seq: number;
      readonly timestamp: number;
      readonly kind: "span.started";
      readonly identity: TraceRunIdentity & {
        readonly spanId: string;
        readonly parentSpanId?: string;
      };
      readonly name: string;
      readonly attributes: TraceAttributes;
    }
  | {
      readonly version: 1;
      readonly seq: number;
      readonly timestamp: number;
      readonly kind: "span.updated";
      readonly spanId: string;
      readonly attribute: { readonly key: string; readonly value: string | number | boolean };
    }
  | {
      readonly version: 1;
      readonly seq: number;
      readonly timestamp: number;
      readonly kind: "span.event";
      readonly spanId: string;
      readonly name: string;
      readonly attributes: TraceAttributes;
    }
  | {
      readonly version: 1;
      readonly seq: number;
      readonly timestamp: number;
      readonly kind: "span.completed";
      readonly spanId: string;
      readonly status: TraceStatus;
      readonly error?: string;
      readonly completedAt: number;
    };

export interface ReplayPayloadReference {
  readonly payloadId: string;
  readonly parts: number;
  readonly encoding: "utf8-json";
}

export interface ReplayRecord {
  readonly version: 1;
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly kind: string;
  readonly correlation: ReplayCorrelation;
  readonly payload?: unknown;
  readonly payloadRef?: ReplayPayloadReference;
}

export interface TraceActivityRecord {
  readonly version: 1;
  readonly seq: number;
  readonly timestamp: number;
  readonly kind: "session.upsert" | "run.started" | "run.updated" | "run.completed";
  readonly sessionId: string;
  readonly runId: string;
  readonly status: TraceRunManifest["status"];
}

export interface TraceIndexRecord {
  readonly version: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status: TraceRunManifest["status"];
}

export interface TraceSpanView {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status: TraceStatus | "running";
  readonly attributes: Record<string, string | number | boolean>;
  readonly events: readonly {
    readonly timestamp: number;
    readonly name: string;
    readonly attributes: TraceAttributes;
  }[];
  readonly error?: string;
}
