import { join } from "node:path";

export class AgentStorageLayout {
  readonly agentDirectory: string;

  constructor(sessionsRoot: string, agentId: string) {
    assertSegment(agentId, "Agent id");
    this.agentDirectory = join(sessionsRoot, agentId);
  }

  checkpointPath(sessionId: string): string {
    assertSegment(sessionId, "Session id");
    return join(this.contextDirectory(sessionId), "checkpoints.json");
  }

  contextLockPath(sessionId: string): string {
    assertSegment(sessionId, "Session id");
    return join(this.agentDirectory, "context", ".locks", `${sessionId}.lock`);
  }

  toolResultArtifactPath(sessionId: string, artifactId: string): string {
    assertSegment(sessionId, "Session id");
    assertSegment(artifactId, "Artifact id");
    return join(this.artifactDirectory(sessionId), "toolResults", `${artifactId}.txt`);
  }

  artifactDirectory(sessionId: string): string {
    assertSegment(sessionId, "Session id");
    return join(this.contextDirectory(sessionId), "artifacts");
  }

  contextDirectory(sessionId: string): string {
    assertSegment(sessionId, "Session id");
    return join(this.agentDirectory, "context", sessionId);
  }
}

function assertSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid: ${value}`);
}
