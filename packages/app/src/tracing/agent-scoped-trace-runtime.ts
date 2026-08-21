import { randomUUID } from "node:crypto";
import {
  sanitizeTracePayload,
  type TraceControlPort,
  type TraceRunIdentity,
} from "@omni-agent/core";
import {
  CompositeRuntimeObserver,
  NOOP_RUNTIME_RUN_OBSERVATION,
  createRuntimeTraceObservers,
  type RuntimeRunObservation,
} from "@omni-agent/core/host";
import { BoundedTraceWriteQueue } from "./bounded-write-queue";
import { LocalRecordingTracer } from "./local-recording-tracer";
import { LocalReplayRecorder } from "./local-replay-recorder";
import { LocalTraceControl } from "./local-trace-control";
import { LocalTraceStore, type TraceStoreDiagnostic } from "./local-trace-store";
import type { TraceRunManifest } from "./trace-schema";
import { TraceStorageLayout } from "./trace-storage-layout";
import type {
  AgentRunObservationPort,
  AgentRunObservationRequest,
} from "../application/agent-run-observation";
import { AgentRunTrace } from "./agent-run-trace";
import type { AgentAssemblySnapshot } from "../assembly/contracts";

export interface AgentScopedTraceRuntimeOptions {
  readonly globalDirectory: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly assembly?: () => AgentAssemblySnapshot;
  readonly writeQueueCapacity?: number;
  readonly onDiagnostic?: (diagnostic: TraceStoreDiagnostic) => void;
}

export interface TraceRunScope {
  readonly identity: TraceRunIdentity;
  readonly startedAt: number;
  readonly assembly?: AgentAssemblySnapshot;
}

export interface AgentTraceInspection {
  location(): string;
  diskUsage(): Promise<number>;
  activeRuns(): Promise<number>;
}

export interface AgentTraceControlCapability {
  readonly control: TraceControlPort;
  readonly inspection: AgentTraceInspection;
}

export class AgentScopedTraceRuntime implements AgentRunObservationPort {
  readonly control = new LocalTraceControl();
  readonly store: LocalTraceStore;
  readonly tracer: LocalRecordingTracer;
  readonly replay: LocalReplayRecorder;
  readonly capability: AgentTraceControlCapability;
  private readonly writes: BoundedTraceWriteQueue;
  private readonly droppedRecordsByRun = new Map<string, number>();

  constructor(private readonly options: AgentScopedTraceRuntimeOptions) {
    this.store = new LocalTraceStore(
      new TraceStorageLayout(options.globalDirectory, options.agentId),
      options.onDiagnostic,
    );
    this.writes = new BoundedTraceWriteQueue({
      capacity: options.writeQueueCapacity ?? 4_096,
      onDiagnostic: (message) => this.store.report("trace_write_queue", message),
    });
    const enqueue = (
      operation: () => Promise<void>,
      priority: "critical" | "detail",
      runId: string,
    ): boolean =>
      this.writes.enqueue(operation, priority, () => {
        this.droppedRecordsByRun.set(runId, (this.droppedRecordsByRun.get(runId) ?? 0) + 1);
      });
    this.tracer = new LocalRecordingTracer(this.store, enqueue);
    this.replay = new LocalReplayRecorder(this.store, enqueue);
    this.capability = {
      control: this.control,
      inspection: {
        location: () => this.store.layout.agentRoot(),
        diskUsage: () => this.store.diskUsage(),
        activeRuns: () => this.store.activeRunCount(),
      },
    };
  }

  async beginRun(
    sessionId: string,
    runId: string = randomUUID(),
  ): Promise<TraceRunScope | undefined> {
    if (this.control.status() === "off") return undefined;
    const identity = {
      agentId: this.options.agentId,
      sessionId,
      runId,
      traceId: randomUUID(),
    };
    const startedAt = Date.now();
    const assembly = this.options.assembly?.();
    if (!(await this.store.beginRun(this.manifest(identity, startedAt, "running", assembly)))) {
      return undefined;
    }
    return { identity, startedAt, assembly };
  }

  async observe(
    request: AgentRunObservationRequest,
    operation: Parameters<AgentRunObservationPort["observe"]>[1],
  ): Promise<void> {
    const scope = await this.beginRun(request.sessionId);
    if (!scope) {
      await operation(NOOP_RUNTIME_RUN_OBSERVATION, request.callbacks);
      return;
    }
    await this.withRun(scope, async () => {
      const observation = this.startObservation(scope);
      const runTrace = new AgentRunTrace(this, scope, observation);
      runTrace.start(request.input);
      try {
        await runTrace.execute(() => operation(observation, runTrace.callbacks(request.callbacks)));
        await runTrace.complete();
      } catch (error) {
        await runTrace.fail(error, request.signal);
        throw error;
      }
    });
  }

  withRun<T>(scope: TraceRunScope, operation: () => T): T {
    return this.tracer.withRun(scope.identity, () =>
      this.replay.withRun(scope.identity, operation),
    );
  }

  startObservation(scope: TraceRunScope): RuntimeRunObservation {
    const diagnostic = (value: { operation: string; message: string }) =>
      this.store.report(value.operation, value.message);
    const observer = new CompositeRuntimeObserver(
      createRuntimeTraceObservers(this.tracer, this.replay, diagnostic),
      diagnostic,
    );
    return observer.startRun({
      agentId: scope.identity.agentId,
      sessionId: scope.identity.sessionId,
      runId: scope.identity.runId,
    });
  }

  async completeRun(
    scope: TraceRunScope,
    status: "completed" | "error" | "cancelled",
    summary?: TraceRunManifest["summary"],
  ): Promise<void> {
    await this.flush();
    const droppedRecords = this.droppedRecordsByRun.get(scope.identity.runId) ?? 0;
    const completeSummary = {
      ...(summary ?? {}),
      ...(droppedRecords > 0 ? { capture: { degraded: true as const, droppedRecords } } : {}),
    };
    const sanitizedSummary = sanitizeTracePayload(completeSummary) as TraceRunManifest["summary"];
    await this.store.completeRun({
      ...this.manifest(scope.identity, scope.startedAt, status, scope.assembly),
      completedAt: Date.now(),
      ...(Object.keys(completeSummary).length > 0 ? { summary: sanitizedSummary } : {}),
    });
    this.droppedRecordsByRun.delete(scope.identity.runId);
    this.replay.finish(scope.identity.runId);
    this.tracer.finish(scope.identity.runId);
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }

  async dispose(): Promise<void> {
    await this.flush();
  }

  private manifest(
    identity: TraceRunIdentity,
    startedAt: number,
    status: TraceRunManifest["status"],
    assembly: AgentAssemblySnapshot | undefined,
  ): TraceRunManifest {
    return {
      version: 1,
      ...identity,
      workspaceId: this.options.workspaceId,
      cwd: this.options.cwd,
      ...(assembly ? { assembly } : {}),
      startedAt,
      status,
    };
  }
}
