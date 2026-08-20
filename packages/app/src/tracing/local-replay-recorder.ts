import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  sanitizeTracePayload,
  type ReplayEventInput,
  type ReplaySinkPort,
  type TraceRunIdentity,
} from "@omni-agent/core";
import type { TraceWritePriority } from "./bounded-write-queue";
import { LocalTraceStore } from "./local-trace-store";
import type { ReplayRecord } from "./trace-schema";

const INLINE_PAYLOAD_BYTES = 64 * 1024;

export class LocalReplayRecorder implements ReplaySinkPort {
  private readonly context = new AsyncLocalStorage<TraceRunIdentity>();
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly store: LocalTraceStore,
    private readonly enqueue: (
      operation: () => Promise<void>,
      priority: TraceWritePriority,
      runId: string,
    ) => boolean,
  ) {}

  withRun<T>(run: TraceRunIdentity, operation: () => T): T {
    return this.context.run(run, operation);
  }

  record(event: ReplayEventInput): void {
    const run = this.context.getStore();
    if (!run) return;
    try {
      const sanitized =
        event.payload === undefined
          ? undefined
          : sanitizeTracePayload(event.payload, event.hiddenKeys);
      const json = sanitized === undefined ? undefined : JSON.stringify(sanitized);
      const seq = (this.sequences.get(run.runId) ?? 0) + 1;
      this.sequences.set(run.runId, seq);
      const base: Omit<ReplayRecord, "payload" | "payloadRef"> = {
        version: 1,
        agentId: run.agentId,
        sessionId: run.sessionId,
        runId: run.runId,
        seq,
        timestamp: Date.now(),
        kind: event.kind,
        correlation: { traceId: run.traceId, ...(event.correlation ?? {}) },
      };
      if (!json || Buffer.byteLength(json, "utf8") <= INLINE_PAYLOAD_BYTES) {
        this.enqueue(
          () =>
            this.store.appendReplay(run.sessionId, run.runId, {
              ...base,
              ...(sanitized === undefined ? {} : { payload: sanitized }),
            }),
          replayPriority(event.kind),
          run.runId,
        );
        return;
      }
      const payloadId = randomUUID();
      this.enqueue(
        async () => {
          const payloadRef = await this.store.writePayload(
            run.sessionId,
            run.runId,
            payloadId,
            json,
          );
          await this.store.appendReplay(run.sessionId, run.runId, {
            ...base,
            ...(payloadRef
              ? { payloadRef }
              : {
                  kind: "capture.degraded",
                  payload: { originalKind: event.kind, payloadId },
                }),
          });
        },
        replayPriority(event.kind),
        run.runId,
      );
    } catch (error) {
      this.store.report("record_replay", error);
      const seq = (this.sequences.get(run.runId) ?? 0) + 1;
      this.sequences.set(run.runId, seq);
      this.enqueue(
        () =>
          this.store.appendReplay(run.sessionId, run.runId, {
            version: 1,
            agentId: run.agentId,
            sessionId: run.sessionId,
            runId: run.runId,
            seq,
            timestamp: Date.now(),
            kind: "capture.degraded",
            correlation: { traceId: run.traceId },
            payload: { operation: "record_replay" },
          }),
        "critical",
        run.runId,
      );
    }
  }

  finish(runId: string): void {
    this.sequences.delete(runId);
  }
}

function replayPriority(kind: string): TraceWritePriority {
  return kind.endsWith(".delta") || kind === "context.progress" ? "detail" : "critical";
}
