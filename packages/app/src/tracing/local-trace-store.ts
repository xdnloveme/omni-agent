import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { InterprocessFileLock, sanitizeSensitiveText } from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import type {
  ReplayPayloadReference,
  ReplayRecord,
  SpanLifecycleRecord,
  TraceActivityRecord,
  TraceIndexRecord,
  TraceRunManifest,
} from "./trace-schema";
import { TraceStorageLayout } from "./trace-storage-layout";

const PAYLOAD_PART_BYTES = 64 * 1024;

export interface TraceStoreDiagnostic {
  readonly operation: string;
  readonly message: string;
}

export class LocalTraceStore {
  private readonly lock: InterprocessFileLock;
  private lastActivitySequence = 0;

  constructor(
    readonly layout: TraceStorageLayout,
    private readonly onDiagnostic: (diagnostic: TraceStoreDiagnostic) => void = () => undefined,
  ) {
    this.lock = new InterprocessFileLock(layout.lockPath(), {
      retryMs: 10,
      timeoutMs: 5_000,
    });
  }

  async beginRun(manifest: TraceRunManifest): Promise<boolean> {
    let started = false;
    await this.failOpen("begin_run", async () => {
      await this.withLock(async () => {
        const runRoot = this.layout.runRoot(manifest.sessionId, manifest.runId);
        await this.assertSafePath(runRoot);
        const manifestFile = new AtomicJsonFile<TraceRunManifest>(
          this.layout.manifestPath(manifest.sessionId, manifest.runId),
        );
        if (await manifestFile.read())
          throw new Error(`Trace run already exists: ${manifest.runId}`);
        const sessionManifest = new AtomicJsonFile<TraceSessionManifest>(
          this.layout.sessionManifestPath(manifest.sessionId),
        );
        const existingSession = await sessionManifest.read();
        if (
          existingSession &&
          (existingSession.agentId !== manifest.agentId ||
            existingSession.workspaceId !== manifest.workspaceId ||
            existingSession.cwd !== manifest.cwd)
        ) {
          throw new Error(`Trace session source conflict: ${manifest.sessionId}`);
        }
        try {
          await this.ensurePrivateDirectory(
            this.layout.payloadDirectory(manifest.sessionId, manifest.runId),
          );
          await this.ensurePrivateDirectory(this.layout.activeDirectory());
          await manifestFile.write(manifest);
          if (!existingSession) {
            await sessionManifest.write({
              version: 1,
              agentId: manifest.agentId,
              sessionId: manifest.sessionId,
              workspaceId: manifest.workspaceId,
              cwd: manifest.cwd,
              createdAt: manifest.startedAt,
            });
          }
          await this.appendLine(
            this.layout.activityPath(),
            this.activity(manifest, "session.upsert"),
          );
          await this.appendLine(this.layout.activityPath(), this.activity(manifest, "run.started"));
          await writeFile(
            this.layout.activeMarker(manifest.runId),
            JSON.stringify({
              pid: process.pid,
              sessionId: manifest.sessionId,
              runId: manifest.runId,
            }),
            { mode: 0o600, flag: "wx" },
          );
          started = true;
        } catch (error) {
          await unlink(this.layout.activeMarker(manifest.runId)).catch(() => undefined);
          await rm(runRoot, { recursive: true, force: true });
          throw error;
        }
      });
    });
    return started;
  }

  async appendSpan(sessionId: string, runId: string, record: SpanLifecycleRecord): Promise<void> {
    await this.failOpen("append_span", () =>
      this.appendLine(this.layout.spansPath(sessionId, runId), record),
    );
  }

  async appendReplay(sessionId: string, runId: string, record: ReplayRecord): Promise<void> {
    await this.failOpen("append_replay", () =>
      this.appendLine(this.layout.replayPath(sessionId, runId), record),
    );
  }

  async writePayload(
    sessionId: string,
    runId: string,
    payloadId: string,
    json: string,
  ): Promise<ReplayPayloadReference | undefined> {
    let reference: ReplayPayloadReference | undefined;
    await this.failOpen("write_payload", async () => {
      await this.assertSafePath(this.layout.payloadDirectory(sessionId, runId));
      const bytes = Buffer.from(json, "utf8");
      const parts = Math.max(1, Math.ceil(bytes.length / PAYLOAD_PART_BYTES));
      await this.ensurePrivateDirectory(this.layout.payloadDirectory(sessionId, runId));
      for (let part = 0; part < parts; part++) {
        const slice = bytes.subarray(part * PAYLOAD_PART_BYTES, (part + 1) * PAYLOAD_PART_BYTES);
        const partPath = this.layout.payloadPartPath(sessionId, runId, payloadId, part);
        await writeFile(partPath, slice, {
          mode: 0o600,
          flag: "wx",
        });
        await chmod(partPath, 0o600);
      }
      reference = { payloadId, parts, encoding: "utf8-json" };
    });
    return reference;
  }

  async completeRun(manifest: TraceRunManifest): Promise<void> {
    await this.failOpen("complete_run", async () => {
      await this.withLock(async () => {
        await this.assertSafePath(this.layout.runRoot(manifest.sessionId, manifest.runId));
        try {
          await new AtomicJsonFile<TraceRunManifest>(
            this.layout.manifestPath(manifest.sessionId, manifest.runId),
          ).write(manifest);
          await this.appendLine(this.layout.indexPath(), this.indexRecord(manifest));
          await this.appendLine(
            this.layout.activityPath(),
            this.activity(manifest, "run.completed"),
          );
        } finally {
          await unlink(this.layout.activeMarker(manifest.runId)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
        }
      });
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await this.assertSafePath(this.layout.agentRoot());
      const active = await this.activeMarkers(true);
      if (active.length > 0) throw new Error(`Trace capture is active for ${this.layout.agentId}`);
      const root = this.layout.agentRoot();
      await rm(root, { recursive: true, force: true });
      await this.ensurePrivateDirectory(root);
    });
  }

  async diskUsage(): Promise<number> {
    await this.assertSafePath(this.layout.agentRoot());
    return this.directorySize(this.layout.agentRoot());
  }

  async activeRunCount(): Promise<number> {
    return (await this.activeMarkers(true)).length;
  }

  report(operation: string, error: unknown): void {
    try {
      this.onDiagnostic({
        operation,
        message: sanitizeSensitiveText(
          error instanceof Error ? error.message : String(error),
          4_096,
        ),
      });
    } catch {
      return;
    }
  }

  async assertSafePath(path: string): Promise<void> {
    this.layout.assertWithinAgentRoot(path);
    await this.assertNoSymbolicLinks(path, this.layout.globalDirectory);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = this.layout.lockPath();
    this.layout.assertWithinTracesRoot(lockPath);
    await this.assertNoSymbolicLinks(lockPath, this.layout.globalDirectory);
    return this.lock.runExclusive(operation);
  }

  private async assertNoSymbolicLinks(path: string, boundary: string): Promise<void> {
    let current = path;
    while (true) {
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error("Trace storage path must not contain symbolic links");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current === boundary) return;
      const parent = dirname(current);
      if (parent === current) throw new Error("Trace storage path escaped its root");
      current = parent;
    }
  }

  private async appendLine(path: string, value: unknown): Promise<void> {
    await this.assertSafePath(path);
    await this.ensurePrivateDirectory(dirname(path));
    await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    this.layout.assertWithinAgentRoot(path);
    const root = this.layout.agentRoot();
    const suffix = relative(root, path);
    let current = root;
    for (const segment of suffix ? ["", ...suffix.split(sep)] : [""]) {
      if (segment) current = join(current, segment);
      await mkdir(current, { recursive: true, mode: 0o700 });
      await chmod(current, 0o700);
    }
  }

  private activity(
    manifest: TraceRunManifest,
    kind: TraceActivityRecord["kind"],
  ): TraceActivityRecord {
    const timestamp = Date.now();
    this.lastActivitySequence = Math.max(this.lastActivitySequence + 1, timestamp * 1_000);
    return {
      version: 1,
      seq: this.lastActivitySequence,
      timestamp,
      kind,
      sessionId: manifest.sessionId,
      runId: manifest.runId,
      status: manifest.status,
    };
  }

  private indexRecord(manifest: TraceRunManifest): TraceIndexRecord {
    return {
      version: 1,
      sessionId: manifest.sessionId,
      runId: manifest.runId,
      startedAt: manifest.startedAt,
      ...(manifest.completedAt ? { completedAt: manifest.completedAt } : {}),
      status: manifest.status,
    };
  }

  private async failOpen(operation: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.report(operation, error);
    }
  }

  private async activeMarkers(removeStale: boolean): Promise<string[]> {
    await this.assertSafePath(this.layout.activeDirectory());
    const markers = await readdir(this.layout.activeDirectory()).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const active: string[] = [];
    for (const marker of markers) {
      const path = this.layout.activeMarker(marker);
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
        if (typeof value.pid === "number" && isProcessAlive(value.pid)) {
          active.push(marker);
        } else if (removeStale) {
          await unlink(path);
        }
      } catch {
        if (removeStale) await unlink(path).catch(() => undefined);
      }
    }
    return active;
  }

  private async directorySize(path: string): Promise<number> {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        throw new Error("Trace storage path must not contain symbolic links");
      }
      if (!entry.isDirectory()) return entry.size;
      const children = await readdir(path);
      const sizes = await Promise.all(
        children.map((child) => this.directorySize(join(path, child))),
      );
      return sizes.reduce((total, size) => total + size, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
}

interface TraceSessionManifest {
  readonly version: 1;
  readonly agentId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly createdAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
