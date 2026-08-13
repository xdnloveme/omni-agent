import { join } from "node:path";

export class ContextSidecarLayout {
  constructor(readonly contextRoot: string) {}

  checkpointPath(sessionId: string): string {
    return join(this.contextDirectory(sessionId), "checkpoints.json");
  }

  projectionPath(sessionId: string): string {
    return join(this.contextDirectory(sessionId), "projections.json");
  }

  contextLockPath(sessionId: string): string {
    assertSegment(sessionId, "Session id");
    return join(this.contextRoot, ".locks", `${sessionId}.lock`);
  }

  toolResultArtifactPath(sessionId: string, artifactId: string): string {
    assertSegment(artifactId, "Artifact id");
    return join(this.artifactDirectory(sessionId), "toolResults", `${artifactId}.txt`);
  }

  artifactDirectory(sessionId: string): string {
    return join(this.contextDirectory(sessionId), "artifacts");
  }

  contextDirectory(sessionId: string): string {
    assertSegment(sessionId, "Session id");
    return join(this.contextRoot, sessionId);
  }
}

function assertSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid: ${value}`);
}
