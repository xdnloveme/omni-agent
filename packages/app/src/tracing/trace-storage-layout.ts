import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertTraceId, isAgentId } from "@omni-agent/core";

interface PathOperations {
  readonly sep: string;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

const HOST_PATH: PathOperations = { isAbsolute, relative, resolve, sep };

export class TraceStorageLayout {
  readonly tracesRoot: string;

  constructor(
    readonly globalDirectory: string,
    readonly agentId: string,
  ) {
    if (!isAgentId(agentId)) throw new Error(`Invalid agent id: ${agentId}`);
    this.tracesRoot = join(globalDirectory, "traces");
  }

  agentRoot(): string {
    return join(this.tracesRoot, this.agentId);
  }

  indexPath(): string {
    return join(this.agentRoot(), "index.jsonl");
  }

  activityPath(): string {
    return join(this.agentRoot(), "activity.jsonl");
  }

  lockPath(): string {
    return join(this.tracesRoot, ".locks", `${this.agentId}.lock`);
  }

  activeDirectory(): string {
    return join(this.agentRoot(), ".active");
  }

  activeMarker(runId: string): string {
    return join(this.activeDirectory(), this.segment(runId, "run id"));
  }

  sessionRoot(sessionId: string): string {
    return join(this.agentRoot(), this.segment(sessionId, "session id"));
  }

  sessionManifestPath(sessionId: string): string {
    return join(this.sessionRoot(sessionId), "session-manifest.json");
  }

  runRoot(sessionId: string, runId: string): string {
    return join(this.sessionRoot(sessionId), this.segment(runId, "run id"));
  }

  manifestPath(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "manifest.json");
  }

  spansPath(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "spans.jsonl");
  }

  replayPath(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "replay.jsonl");
  }

  payloadDirectory(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "payloads");
  }

  payloadPartPath(sessionId: string, runId: string, payloadId: string, part: number): string {
    if (!Number.isInteger(part) || part < 0) throw new Error(`Invalid payload part: ${part}`);
    return join(
      this.payloadDirectory(sessionId, runId),
      `${this.segment(payloadId, "payload id")}.json.part-${part}`,
    );
  }

  assertWithinAgentRoot(path: string): void {
    this.assertWithin(path, this.agentRoot(), "Agent root");
  }

  assertWithinTracesRoot(path: string): void {
    this.assertWithin(path, this.tracesRoot, "Trace root");
  }

  private assertWithin(path: string, boundary: string, label: string): void {
    if (!isPathWithin(path, boundary)) {
      throw new Error(`Trace path escapes the ${label}`);
    }
  }

  private segment(value: string, label: string): string {
    assertTraceId(value, label);
    return value;
  }
}

export function isPathWithin(
  path: string,
  boundary: string,
  operations: PathOperations = HOST_PATH,
): boolean {
  const pathFromBoundary = operations.relative(
    operations.resolve(boundary),
    operations.resolve(path),
  );
  return (
    pathFromBoundary !== ".." &&
    !pathFromBoundary.startsWith(`..${operations.sep}`) &&
    !operations.isAbsolute(pathFromBoundary)
  );
}
