import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextCheckpoint } from "@omni-agent/core";
import {
  AgentStorageLayout,
  ContextArtifactRepository,
  ContextCheckpointRepository,
  ContextSidecarLifecycle,
} from "../context";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checkpoint(sessionId: string): ContextCheckpoint {
  return {
    id: "checkpoint-1",
    sessionId,
    sessionRevision: 1,
    coveredMessageCount: 2,
    coveredTranscriptDigest: "source",
    sourceMiddlewareDigest: "middleware",
    sourcePolicyDigest: "policy",
    gateName: "heavy_checkpoint_gate",
    gateVersion: 1,
    promptVersion: 1,
    summary: "summary",
    summaryDigest: "summary-digest",
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
    const layout = new AgentStorageLayout(root, "coding");
    const checkpoints = new ContextCheckpointRepository(layout);
    const artifacts = new ContextArtifactRepository(layout);
    const lifecycle = new ContextSidecarLifecycle(layout);

    await checkpoints.append(checkpoint("session-1"));
    const artifactPath = await artifacts.write({
      sessionId: "session-1",
      artifactId: "artifact-1",
      content: "large result",
    });
    await artifacts.write({
      sessionId: "session-1",
      artifactId: "artifact-1",
      content: "large result",
    });

    expect(await checkpoints.list("session-1")).toHaveLength(1);
    expect(artifactPath).toContain("coding/context/session-1/artifacts/toolResults");
    await lifecycle.clear("session-1");
    await expect(readdir(layout.contextDirectory("session-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("quarantines a corrupt checkpoint sidecar and rebuilds from empty derived state", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-context-storage-"));
    roots.push(root);
    const layout = new AgentStorageLayout(root, "coding");
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
});
