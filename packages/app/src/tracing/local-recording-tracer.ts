import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  NOOP_SPAN,
  assertTraceName,
  sanitizeSensitiveText,
  type SpanPort,
  type TraceAttributes,
  type TraceRunIdentity,
  type TraceStatus,
  type TracerPort,
} from "@omni-agent/core";
import type { TraceWritePriority } from "./bounded-write-queue";
import type { SpanLifecycleRecord } from "./trace-schema";
import { LocalTraceStore } from "./local-trace-store";

interface ActiveTraceContext {
  readonly run: TraceRunIdentity;
  readonly parentSpanId?: string;
}

const MAX_ATTRIBUTES = 64;
const MAX_ATTRIBUTE_LENGTH = 4_096;

export class LocalRecordingTracer implements TracerPort {
  private readonly context = new AsyncLocalStorage<ActiveTraceContext>();
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
    return this.context.run({ run }, operation);
  }

  startSpan(name: string, attributes: TraceAttributes = {}): SpanPort {
    const active = this.context.getStore();
    if (!active) return NOOP_SPAN;
    try {
      assertTraceName(name);
    } catch (error) {
      this.store.report("start_span", error);
      return NOOP_SPAN;
    }
    const span = new LocalSpan(
      {
        ...active.run,
        spanId: randomUUID(),
        ...(active.parentSpanId ? { parentSpanId: active.parentSpanId } : {}),
      },
      name,
      sanitizeAttributes(attributes),
      this.context,
      this.store,
      () => {
        const sequence = (this.sequences.get(active.run.runId) ?? 0) + 1;
        this.sequences.set(active.run.runId, sequence);
        return sequence;
      },
      this.enqueue,
    );
    span.start();
    return span;
  }

  finish(runId: string): void {
    this.sequences.delete(runId);
  }
}

class LocalSpan implements SpanPort {
  private ended = false;
  private status: TraceStatus = "unset";
  private error: string | undefined;

  constructor(
    readonly identity: TraceRunIdentity & { spanId: string; parentSpanId?: string },
    private readonly name: string,
    private readonly attributes: TraceAttributes,
    private readonly context: AsyncLocalStorage<ActiveTraceContext>,
    private readonly store: LocalTraceStore,
    private readonly nextSequence: () => number,
    private readonly enqueue: (
      operation: () => Promise<void>,
      priority: TraceWritePriority,
      runId: string,
    ) => boolean,
  ) {}

  start(): void {
    this.write({
      version: 1,
      seq: this.nextSequence(),
      timestamp: Date.now(),
      kind: "span.started",
      identity: this.identity,
      name: this.name,
      attributes: this.attributes,
    });
  }

  setAttribute(key: string, value: string | number | boolean): void {
    if (this.ended) return;
    try {
      assertTraceName(key);
    } catch (error) {
      this.store.report("set_span_attribute", error);
      return;
    }
    this.write({
      version: 1,
      seq: this.nextSequence(),
      timestamp: Date.now(),
      kind: "span.updated",
      spanId: this.identity.spanId,
      attribute: { key, value: sanitizeAttributeValue(value) },
    });
  }

  addEvent(name: string, attributes: TraceAttributes = {}): void {
    if (this.ended) return;
    try {
      assertTraceName(name);
    } catch (error) {
      this.store.report("add_span_event", error);
      return;
    }
    this.write({
      version: 1,
      seq: this.nextSequence(),
      timestamp: Date.now(),
      kind: "span.event",
      spanId: this.identity.spanId,
      name,
      attributes: sanitizeAttributes(attributes),
    });
  }

  recordError(error: unknown): void {
    if (this.ended) return;
    this.error = sanitizeSensitiveText(
      error instanceof Error ? error.message : String(error),
      MAX_ATTRIBUTE_LENGTH,
    );
    this.status = "error";
  }

  setStatus(status: TraceStatus): void {
    if (this.ended || (this.status === "error" && status === "ok")) return;
    this.status = status;
  }

  run<T>(operation: () => T): T {
    return this.context.run({ run: this.identity, parentSpanId: this.identity.spanId }, operation);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.write({
      version: 1,
      seq: this.nextSequence(),
      timestamp: Date.now(),
      kind: "span.completed",
      spanId: this.identity.spanId,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      completedAt: Date.now(),
    });
  }

  private write(record: SpanLifecycleRecord): void {
    this.enqueue(
      () => this.store.appendSpan(this.identity.sessionId, this.identity.runId, record),
      "critical",
      this.identity.runId,
    );
  }
}

function sanitizeAttributes(attributes: TraceAttributes): TraceAttributes {
  return Object.fromEntries(
    Object.entries(attributes)
      .slice(0, MAX_ATTRIBUTES)
      .map(([key, value]) => [key, sanitizeAttributeValue(value)]),
  );
}

function sanitizeAttributeValue(value: string | number | boolean): string | number | boolean {
  return typeof value === "string" ? sanitizeSensitiveText(value, MAX_ATTRIBUTE_LENGTH) : value;
}
