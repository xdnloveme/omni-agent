import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  digestContextValue,
  type ContextCheckpoint,
  type ContextProjectionState,
} from "@omni-agent/core";
import {
  ContextCheckpointRepository,
  ContextProjectionRepository,
  ContextSidecarLifecycle,
  ContextSidecarLayout,
} from "../context";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checkpoint(sessionId: string): ContextCheckpoint {
  const summary = "summary";
  return {
    id: "checkpoint-1",
    sessionId,
    sessionRevision: 1,
    coveredMessageCount: 2,
    coveredTranscriptDigest: digestContextValue("source"),
    sourceMiddlewareDigest: digestContextValue("middleware"),
    sourcePolicyDigest: digestContextValue("policy"),
    gateName: "heavy_checkpoint_gate",
    gateVersion: 1,
    promptVersion: 1,
    summary,
    summaryDigest: digestContextValue(summary),
    estimatedSummaryTokens: 2,
    summaryModelCallId: "summary-call-1",
    generatedBy: { provider: "test", model: "model" },
    createdAt: new Date(0).toISOString(),
  };
}

describe("Context sidecar storage", () => {
  it("co-locates data with the Agent Session root while keeping repositories isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-context-storage-"));
    roots.push(root);
    const layout = new ContextSidecarLayout(join(root, "coding", "context"));
    const checkpoints = new ContextCheckpointRepository(layout);
    const projections = new ContextProjectionRepository(layout);
    const lifecycle = new ContextSidecarLifecycle(layout);

    await checkpoints.append(checkpoint("session-1"));
    const artifactPath = projections.artifactPath("session-1", "artifact-1");
    await projections.commit({
      sessionId: "session-1",
      expectedRevision: 0,
      nextState: projectionState("session-1", 1),
      artifacts: [
        {
          artifactId: "artifact-1",
          content: "large result",
          contentDigest: digestContextValue("large result"),
        },
      ],
    });

    expect(await checkpoints.list("session-1")).toHaveLength(1);
    expect(artifactPath).toContain("coding/context/session-1/artifacts/toolResults");
    expect(
      await projections.artifactMatches(
        "session-1",
        "artifact-1",
        digestContextValue("large result"),
      ),
    ).toBe(true);
    await writeFile(artifactPath, "tampered", "utf8");
    expect(
      await projections.artifactMatches(
        "session-1",
        "artifact-1",
        digestContextValue("large result"),
      ),
    ).toBe(false);
    await lifecycle.clear("session-1");
    await expect(readdir(layout.contextDirectory("session-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("quarantines a corrupt checkpoint sidecar and rebuilds from empty derived state", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-context-storage-"));
    roots.push(root);
    const layout = new ContextSidecarLayout(join(root, "coding", "context"));
    const diagnostics = vi.fn();
    const repository = new ContextCheckpointRepository(layout, diagnostics);
    await mkdir(layout.contextDirectory("session-1"), { recursive: true });
    await writeFile(layout.checkpointPath("session-1"), "{broken", { encoding: "utf8" });

    expect(await repository.list("session-1")).toEqual([]);
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(
      (await readdir(layout.contextDirectory("session-1"))).some((name) =>
        name.startsWith("checkpoints.json.corrupt-"),
      ),
    ).toBe(true);
  });

  it("validates checkpoint lineage and distinguishes idempotence from id conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-context-storage-"));
    roots.push(root);
    const repository = new ContextCheckpointRepository(
      new ContextSidecarLayout(join(root, "coding", "context")),
    );
    const parent = checkpoint("session-1");
    const childSummary = "child summary";
    const child: ContextCheckpoint = {
      ...parent,
      id: "checkpoint-2",
      parentId: parent.id,
      coveredMessageCount: parent.coveredMessageCount + 1,
      summary: childSummary,
      summaryDigest: digestContextValue(childSummary),
      summaryModelCallId: "summary-call-2",
      createdAt: new Date(1).toISOString(),
    };

    await repository.append(parent);
    await repository.append(parent);
    await repository.append(child);
    expect(await repository.list("session-1")).toHaveLength(2);

    const conflictingSummary = "conflicting summary";
    await expect(
      repository.append({
        ...parent,
        summary: conflictingSummary,
        summaryDigest: digestContextValue(conflictingSummary),
      }),
    ).rejects.toThrow("id conflict");
    await expect(
      repository.append({
        ...child,
        id: "checkpoint-3",
        parentId: "missing",
      }),
    ).rejects.toThrow("Missing checkpoint parent");
    await expect(
      repository.append({
        ...child,
        id: "checkpoint-4",
        coveredMessageCount: parent.coveredMessageCount,
      }),
    ).rejects.toThrow("coverage must increase");
    await expect(
      repository.append({ ...child, id: "checkpoint-5", summaryDigest: "invalid" }),
    ).rejects.toThrow("Invalid checkpoint record");
    await expect(
      repository.append({ ...child, id: "checkpoint-6", createdAt: "not-a-date" }),
    ).rejects.toThrow("Invalid checkpoint record");
  });

  it("rejects stale projection commits without replacing current state", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-context-storage-"));
    roots.push(root);
    const layout = new ContextSidecarLayout(join(root, "coding", "context"));
    const repository = new ContextProjectionRepository(layout);
    await repository.commit({
      sessionId: "session-1",
      expectedRevision: 0,
      nextState: projectionState("session-1", 1),
      artifacts: [],
    });

    await expect(
      repository.commit({
        sessionId: "session-1",
        expectedRevision: 0,
        nextState: projectionState("session-1", 1),
        artifacts: [],
      }),
    ).rejects.toThrow("revision conflict");
    expect((await repository.load("session-1"))?.revision).toBe(1);
  });

  it("quarantines corrupt Projection state and rebuilds from no derived state", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-context-storage-"));
    roots.push(root);
    const layout = new ContextSidecarLayout(join(root, "coding", "context"));
    const diagnostics = vi.fn();
    const repository = new ContextProjectionRepository(layout, diagnostics);
    await mkdir(layout.contextDirectory("session-1"), { recursive: true });
    await writeFile(layout.projectionPath("session-1"), "{broken", { encoding: "utf8" });

    expect(await repository.load("session-1")).toBeUndefined();
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(
      (await readdir(layout.contextDirectory("session-1"))).some((name) =>
        name.startsWith("projections.json.corrupt-"),
      ),
    ).toBe(true);
  });
});

function projectionState(sessionId: string, revision: number): ContextProjectionState {
  const strategy = (name: string) => ({
    strategyName: name,
    strategyVersion: 1,
    configurationDigest: "configuration",
    records: [],
  });
  return {
    version: 1,
    sessionId,
    revision,
    strategies: { custom: strategy("custom_projection") },
  };
}
