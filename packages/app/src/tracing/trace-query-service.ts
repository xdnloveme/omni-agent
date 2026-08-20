import { readFile, readdir, stat } from "node:fs/promises";
import type {
  ReplayPayloadReference,
  ReplayRecord,
  TraceActivityRecord,
  SpanLifecycleRecord,
  TraceIndexRecord,
  TraceRunManifest,
  TraceSpanView,
} from "./trace-schema";
import { readJsonLinesChunk, readValidatedJsonLines, type JsonLinesChunk } from "./jsonl-reader";
import { LocalTraceStore } from "./local-trace-store";

export interface TraceQueryPort {
  agent(): { agentId: string };
  diskUsage(): Promise<number>;
  sessions(): Promise<
    { sessionId: string; runs: number; latestStartedAt: number; status: string }[]
  >;
  runs(sessionId: string): Promise<TraceRunManifest[]>;
  run(sessionId: string, runId: string): Promise<TraceRunManifest>;
  spanSnapshot(
    sessionId: string,
    runId: string,
  ): Promise<{ spans: TraceSpanView[]; cursor: number }>;
  replayChunk(
    sessionId: string,
    runId: string,
    cursor?: number,
    limit?: number,
  ): Promise<JsonLinesChunk<ReplayRecord>>;
  spanRecords(
    sessionId: string,
    runId: string,
    cursor?: number,
    limit?: number,
  ): Promise<JsonLinesChunk<SpanLifecycleRecord>>;
  activityChunk(cursor?: number, limit?: number): Promise<JsonLinesChunk<TraceActivityRecord>>;
  activityEndCursor(): Promise<number>;
  payloadParts(
    sessionId: string,
    runId: string,
    reference: ReplayPayloadReference,
  ): AsyncGenerator<Buffer>;
}

export class TraceQueryService implements TraceQueryPort {
  constructor(private readonly store: LocalTraceStore) {}

  agent(): { agentId: string } {
    return { agentId: this.store.layout.agentId };
  }

  diskUsage(): Promise<number> {
    return this.store.diskUsage();
  }

  async sessions(): Promise<
    { sessionId: string; runs: number; latestStartedAt: number; status: string }[]
  > {
    await this.store.assertSafePath(this.store.layout.agentRoot());
    const records = await this.index();
    const active = await this.activeRuns();
    const merged = new Map<string, TraceIndexRecord>();
    for (const record of [...records, ...active]) {
      merged.set(`${record.sessionId}:${record.runId}`, record);
    }
    const sessions = new Map<
      string,
      { sessionId: string; runs: number; latestStartedAt: number; status: string }
    >();
    for (const record of merged.values()) {
      const current = sessions.get(record.sessionId);
      if (!current) {
        sessions.set(record.sessionId, {
          sessionId: record.sessionId,
          runs: 1,
          latestStartedAt: record.startedAt,
          status: record.status,
        });
      } else {
        current.runs += 1;
        if (record.startedAt >= current.latestStartedAt) {
          current.latestStartedAt = record.startedAt;
          current.status = record.status;
        }
      }
    }
    return [...sessions.values()].sort((a, b) => b.latestStartedAt - a.latestStartedAt);
  }

  async runs(sessionId: string): Promise<TraceRunManifest[]> {
    const root = this.store.layout.sessionRoot(sessionId);
    await this.store.assertSafePath(root);
    const entries = await readdir(root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.run(sessionId, entry.name).catch(() => undefined)),
    );
    return manifests
      .filter((entry): entry is TraceRunManifest => entry !== undefined)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async run(sessionId: string, runId: string): Promise<TraceRunManifest> {
    const path = this.store.layout.manifestPath(sessionId, runId);
    await this.store.assertSafePath(path);
    const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isTraceRunManifest(manifest)) throw new Error(`Trace run is invalid: ${runId}`);
    return manifest;
  }

  async spans(sessionId: string, runId: string): Promise<TraceSpanView[]> {
    return (await this.spanSnapshot(sessionId, runId)).spans;
  }

  async spanSnapshot(
    sessionId: string,
    runId: string,
  ): Promise<{ spans: TraceSpanView[]; cursor: number }> {
    const records: SpanLifecycleRecord[] = [];
    let cursor = 0;
    while (true) {
      const page = await this.spanRecords(sessionId, runId, cursor, 1_000);
      records.push(...page.entries.map((entry) => entry.value));
      if (page.cursor === cursor) break;
      cursor = page.cursor;
    }
    return { spans: foldSpanRecords(records), cursor };
  }

  replay(sessionId: string, runId: string, cursor = 0, limit = 500): Promise<ReplayRecord[]> {
    return this.replayChunk(sessionId, runId, cursor, limit).then((page) =>
      page.entries.map((entry) => entry.value),
    );
  }

  async replayChunk(
    sessionId: string,
    runId: string,
    cursor = 0,
    limit = 500,
  ): Promise<JsonLinesChunk<ReplayRecord>> {
    const path = this.store.layout.replayPath(sessionId, runId);
    await this.store.assertSafePath(path);
    return readJsonLinesChunk<ReplayRecord>(path, cursor, limit, isReplayRecord);
  }

  async spanRecords(
    sessionId: string,
    runId: string,
    cursor = 0,
    limit = 500,
  ): Promise<JsonLinesChunk<SpanLifecycleRecord>> {
    const path = this.store.layout.spansPath(sessionId, runId);
    await this.store.assertSafePath(path);
    return readJsonLinesChunk<SpanLifecycleRecord>(path, cursor, limit, isSpanLifecycleRecord);
  }

  async activityChunk(cursor = 0, limit = 1_000): Promise<JsonLinesChunk<TraceActivityRecord>> {
    const path = this.store.layout.activityPath();
    await this.store.assertSafePath(path);
    return readJsonLinesChunk<TraceActivityRecord>(path, cursor, limit, isTraceActivityRecord);
  }

  async activityEndCursor(): Promise<number> {
    const path = this.store.layout.activityPath();
    await this.store.assertSafePath(path);
    return stat(path)
      .then((entry) => entry.size)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
  }

  async payload(
    sessionId: string,
    runId: string,
    reference: ReplayPayloadReference,
  ): Promise<unknown> {
    const parts: Buffer[] = [];
    for await (const part of this.payloadParts(sessionId, runId, reference)) parts.push(part);
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }

  async *payloadParts(
    sessionId: string,
    runId: string,
    reference: ReplayPayloadReference,
  ): AsyncGenerator<Buffer> {
    for (let part = 0; part < reference.parts; part++) {
      const path = this.store.layout.payloadPartPath(sessionId, runId, reference.payloadId, part);
      await this.store.assertSafePath(path);
      yield await readFile(path);
    }
  }

  private async index(): Promise<TraceIndexRecord[]> {
    const indexPath = this.store.layout.indexPath();
    await this.store.assertSafePath(indexPath);
    const cached = new Map(
      (await readValidatedJsonLines<TraceIndexRecord>(indexPath, isTraceIndexRecord)).map(
        (record) => [`${record.sessionId}:${record.runId}`, record],
      ),
    );
    const sessions = await readdir(this.store.layout.agentRoot(), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const rebuilt: TraceIndexRecord[] = [];
    for (const session of sessions) {
      if (!session.isDirectory() || session.name.startsWith(".")) continue;
      const runDirectories = await readdir(this.store.layout.sessionRoot(session.name), {
        withFileTypes: true,
      });
      for (const runDirectory of runDirectories) {
        if (!runDirectory.isDirectory()) continue;
        const key = `${session.name}:${runDirectory.name}`;
        const indexed = cached.get(key);
        if (indexed) {
          try {
            const manifestPath = this.store.layout.manifestPath(session.name, runDirectory.name);
            await this.store.assertSafePath(manifestPath);
            if ((await stat(manifestPath)).isFile()) {
              rebuilt.push(indexed);
              continue;
            }
          } catch {
            // Fall through to manifest recovery below.
          }
        }
        const manifest = await this.run(session.name, runDirectory.name).catch(() => undefined);
        if (manifest) {
          rebuilt.push({
            version: 1,
            sessionId: manifest.sessionId,
            runId: manifest.runId,
            startedAt: manifest.startedAt,
            ...(manifest.completedAt ? { completedAt: manifest.completedAt } : {}),
            status: manifest.status,
          });
        }
      }
    }
    return rebuilt;
  }

  private async activeRuns(): Promise<TraceIndexRecord[]> {
    await this.store.assertSafePath(this.store.layout.activeDirectory());
    const markers = await readdir(this.store.layout.activeDirectory()).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const active: TraceIndexRecord[] = [];
    for (const marker of markers) {
      try {
        const value: unknown = JSON.parse(
          await readFile(this.store.layout.activeMarker(marker), "utf8"),
        );
        if (
          !isRecord(value) ||
          typeof value.sessionId !== "string" ||
          typeof value.runId !== "string"
        ) {
          continue;
        }
        const manifest = await this.run(value.sessionId, value.runId);
        active.push({
          version: 1,
          sessionId: manifest.sessionId,
          runId: manifest.runId,
          startedAt: manifest.startedAt,
          status: manifest.status,
        });
      } catch {
        continue;
      }
    }
    return active;
  }
}

function foldSpanRecords(records: readonly SpanLifecycleRecord[]): TraceSpanView[] {
  const views = new Map<string, MutableSpanView>();
  for (const record of records) {
    if (record.kind === "span.started") {
      views.set(record.identity.spanId, {
        spanId: record.identity.spanId,
        ...(record.identity.parentSpanId ? { parentSpanId: record.identity.parentSpanId } : {}),
        name: record.name,
        startedAt: record.timestamp,
        status: "running",
        attributes: { ...record.attributes },
        events: [],
      });
    } else {
      const view = views.get(record.spanId);
      if (!view) continue;
      if (record.kind === "span.updated") {
        view.attributes[record.attribute.key] = record.attribute.value;
      } else if (record.kind === "span.event") {
        view.events.push({
          timestamp: record.timestamp,
          name: record.name,
          attributes: record.attributes,
        });
      } else {
        view.completedAt = record.completedAt;
        view.status = record.status;
        if (record.error) view.error = record.error;
      }
    }
  }
  return [...views.values()].sort((a, b) => a.startedAt - b.startedAt);
}

interface MutableSpanView {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: number;
  completedAt?: number;
  status: TraceSpanView["status"];
  attributes: Record<string, string | number | boolean>;
  events: {
    timestamp: number;
    name: string;
    attributes: TraceSpanView["events"][number]["attributes"];
  }[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.seq === "number" &&
    typeof value.timestamp === "number" &&
    typeof value.kind === "string"
  );
}

function isReplayRecord(value: unknown): value is ReplayRecord {
  return (
    hasEnvelope(value) &&
    typeof value.agentId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.runId === "string" &&
    isRecord(value.correlation)
  );
}

function isSpanLifecycleRecord(value: unknown): value is SpanLifecycleRecord {
  if (!hasEnvelope(value)) return false;
  if (value.kind === "span.started") {
    return (
      isRecord(value.identity) &&
      typeof value.identity.spanId === "string" &&
      typeof value.name === "string" &&
      isRecord(value.attributes)
    );
  }
  if (typeof value.spanId !== "string") return false;
  if (value.kind === "span.updated") {
    return (
      isRecord(value.attribute) &&
      typeof value.attribute.key === "string" &&
      isTraceScalar(value.attribute.value)
    );
  }
  if (value.kind === "span.event") {
    return typeof value.name === "string" && isRecord(value.attributes);
  }
  if (value.kind === "span.completed") {
    return (
      typeof value.completedAt === "number" &&
      ["unset", "ok", "error", "cancelled", "denied", "timed_out"].includes(String(value.status))
    );
  }
  return false;
}

function isTraceActivityRecord(value: unknown): value is TraceActivityRecord {
  return (
    hasEnvelope(value) &&
    ["session.upsert", "run.started", "run.updated", "run.completed"].includes(
      String(value.kind),
    ) &&
    typeof value.sessionId === "string" &&
    typeof value.runId === "string" &&
    typeof value.status === "string"
  );
}

function isTraceIndexRecord(value: unknown): value is TraceIndexRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.sessionId === "string" &&
    typeof value.runId === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.status === "string"
  );
}

function isTraceRunManifest(value: unknown): value is TraceRunManifest {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.agentId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.runId === "string" &&
    typeof value.traceId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.cwd === "string" &&
    typeof value.startedAt === "number" &&
    ["running", "completed", "error", "cancelled"].includes(String(value.status))
  );
}

function isTraceScalar(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}
