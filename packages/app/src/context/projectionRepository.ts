import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  digestContextValue,
  type ContextProjectionState,
  type ContextProjectionStorePort,
} from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import type { ContextSidecarLayout } from "./sidecarLayout";
import { createContextSidecarLock, readValidatedSidecar } from "./sidecarStore";

export class ContextProjectionRevisionError extends Error {
  constructor(expected: number, actual: number) {
    super(`Context projection revision conflict: expected ${expected}, received ${actual}`);
    this.name = "ContextProjectionRevisionError";
  }
}

export class ContextProjectionRepository implements ContextProjectionStorePort {
  constructor(
    private readonly layout: ContextSidecarLayout,
    private readonly onDiagnostic?: (message: string) => void,
  ) {}

  async load(sessionId: string): Promise<ContextProjectionState | undefined> {
    return this.lock(sessionId).runExclusive(() => this.readOrQuarantine(sessionId));
  }

  artifactPath(sessionId: string, artifactId: string): string {
    return this.layout.toolResultArtifactPath(sessionId, artifactId);
  }

  async artifactMatches(
    sessionId: string,
    artifactId: string,
    contentDigest: string,
  ): Promise<boolean> {
    try {
      const path = this.artifactPath(sessionId, artifactId);
      if (!(await stat(path)).isFile()) return false;
      return digestContextValue(await readFile(path, "utf8")) === contentDigest;
    } catch (error) {
      if (["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }

  async commit(input: Parameters<ContextProjectionStorePort["commit"]>[0]): Promise<void> {
    await this.lock(input.sessionId).runExclusive(async () => {
      const current = await this.readOrQuarantine(input.sessionId);
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== input.expectedRevision) {
        throw new ContextProjectionRevisionError(input.expectedRevision, actualRevision);
      }
      assertProjectionState(input.nextState, input.sessionId);
      if (input.nextState.revision !== actualRevision + 1) {
        throw new Error("Context projection commit must advance revision exactly once");
      }
      for (const artifact of input.artifacts) {
        if (digestContextValue(artifact.content) !== artifact.contentDigest) {
          throw new Error(`Context artifact content digest is invalid: ${artifact.artifactId}`);
        }
        await this.writeArtifact(input.sessionId, artifact.artifactId, artifact.content);
      }
      await this.file(input.sessionId).write(structuredClone(input.nextState));
    });
  }

  private async writeArtifact(
    sessionId: string,
    artifactId: string,
    content: string,
  ): Promise<void> {
    const path = this.artifactPath(sessionId, artifactId);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(path, "utf8")) !== content) {
        throw new Error(`Context artifact digest collision: ${artifactId}`);
      }
    }
  }

  private async readOrQuarantine(sessionId: string): Promise<ContextProjectionState | undefined> {
    const file = this.file(sessionId);
    const value = await readValidatedSidecar({
      file,
      path: this.layout.projectionPath(sessionId),
      validate: (candidate): asserts candidate is ContextProjectionState =>
        assertProjectionState(candidate, sessionId),
      label: "Context projection sidecar",
      onDiagnostic: this.onDiagnostic,
    });
    return value === undefined ? undefined : structuredClone(value);
  }

  private file(sessionId: string): AtomicJsonFile<ContextProjectionState> {
    return new AtomicJsonFile(this.layout.projectionPath(sessionId));
  }

  private lock(sessionId: string) {
    return createContextSidecarLock(this.layout, sessionId);
  }
}

function assertProjectionState(
  value: unknown,
  sessionId: string,
): asserts value is ContextProjectionState {
  if (!value || typeof value !== "object") throw new Error("Invalid context projection sidecar");
  const candidate = value as Partial<ContextProjectionState>;
  if (
    candidate.version !== 1 ||
    candidate.sessionId !== sessionId ||
    !Number.isInteger(candidate.revision) ||
    (candidate.revision ?? -1) < 0 ||
    !candidate.strategies ||
    typeof candidate.strategies !== "object" ||
    Array.isArray(candidate.strategies)
  ) {
    throw new Error("Unsupported context projection sidecar schema");
  }
  for (const [key, strategy] of Object.entries(candidate.strategies)) {
    if (
      !/^[a-z][a-z0-9_]*$/.test(key) ||
      !strategy ||
      typeof strategy.strategyName !== "string" ||
      !Number.isInteger(strategy.strategyVersion) ||
      strategy.strategyVersion < 1 ||
      typeof strategy.configurationDigest !== "string" ||
      !Array.isArray(strategy.records)
    ) {
      throw new Error(`Invalid context projection strategy: ${key}`);
    }
    for (const record of strategy.records) {
      if (
        !record ||
        record.kind !== key ||
        typeof record.sourceId !== "string" ||
        !Number.isInteger(record.sourceIndex) ||
        record.sourceIndex < 0 ||
        typeof record.sourceDigest !== "string" ||
        typeof record.projectionDigest !== "string"
      ) {
        throw new Error(`Invalid context projection record: ${key}`);
      }
    }
  }
}
