import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentScopedTraceRuntime } from "./agent-scoped-trace-runtime";
import { BoundedTraceWriteQueue } from "./bounded-write-queue";
import { readJsonLinesChunk } from "./jsonl-reader";
import { LocalTraceControl } from "./local-trace-control";
import { TraceQueryService } from "./trace-query-service";
import { isPathWithin } from "./trace-storage-layout";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(agentId = "coding", writeQueueCapacity?: number) {
  const root = await mkdtemp(join(tmpdir(), "omni-trace-"));
  directories.push(root);
  const runtime = new AgentScopedTraceRuntime({
    globalDirectory: root,
    agentId,
    workspaceId: "workspace",
    cwd: root,
    writeQueueCapacity,
  });
  runtime.control.start();
  const scope = await runtime.beginRun("session", "run");
  if (!scope) throw new Error("Trace scope was not created");
  return { root, runtime, scope };
}

describe("local tracing", () => {
  it("keeps capture off until the host explicitly enables it", async () => {
    const control = new LocalTraceControl();

    expect(control.status()).toBe("off");
    control.start();
    expect(control.status()).toBe("on");
    control.stop();
    expect(control.status()).toBe("off");
  });

  it("persists ordered replay and a parented active span tree", async () => {
    const { runtime, scope } = await fixture();

    await runtime.withRun(scope, async () => {
      const root = runtime.tracer.startSpan("agent.run");
      await root.run(async () => {
        const turn = runtime.tracer.startSpan("agent.turn");
        await turn.run(async () => {
          runtime.replay.record({ kind: "user.input", payload: { text: "hello" } });
          const model = runtime.tracer.startSpan("gen_ai.generate");
          model.setAttribute("gen_ai.usage.input_tokens", 4);
          model.setStatus("ok");
          model.end();
        });
        turn.setStatus("ok");
        turn.end();
      });
      root.setStatus("ok");
      root.end();
    });
    await runtime.flush();

    const query = new TraceQueryService(runtime.store);
    const active = await query.run("session", "run");
    expect(active.status).toBe("running");
    const spans = await query.spans("session", "run");
    expect(spans.map((span) => span.name)).toEqual(["agent.run", "agent.turn", "gen_ai.generate"]);
    expect(spans[1]?.parentSpanId).toBe(spans[0]?.spanId);
    expect(spans[2]?.parentSpanId).toBe(spans[1]?.spanId);
    expect(spans.every((span) => span.status === "ok")).toBe(true);
    expect(await query.replay("session", "run")).toMatchObject([
      { seq: 1, kind: "user.input", payload: { text: "hello" } },
    ]);
  });

  it("stores complete sanitized large payloads in ordered parts", async () => {
    const { runtime, scope } = await fixture();
    const value = `payload-${"x".repeat(150_000)}`;

    runtime.withRun(scope, () => {
      runtime.replay.record({
        kind: "model.request.captured",
        payload: { authorization: "Bearer private", value },
      });
    });
    await runtime.flush();

    const query = new TraceQueryService(runtime.store);
    const [record] = await query.replay("session", "run");
    expect(record?.payloadRef?.parts).toBeGreaterThan(1);
    const payload = (await query.payload("session", "run", record!.payloadRef!)) as Record<
      string,
      string
    >;
    expect(payload.authorization).toBe("[REDACTED]");
    expect(payload.value).toBe(value);
  });

  it("keeps an active run recording after capture is disabled", async () => {
    const { runtime, scope } = await fixture();

    runtime.withRun(scope, () => {
      runtime.control.stop();
      runtime.replay.record({ kind: "user.input", payload: { text: "still captured" } });
      const span = runtime.tracer.startSpan("agent.turn");
      span.setStatus("ok");
      span.end();
    });
    await runtime.completeRun(scope, "completed");

    const query = new TraceQueryService(runtime.store);
    expect(await query.replay("session", "run")).toMatchObject([
      { kind: "user.input", payload: { text: "still captured" } },
    ]);
    expect(await query.spans("session", "run")).toMatchObject([
      { name: "agent.turn", status: "ok" },
    ]);
    expect(await runtime.beginRun("session", "next-run")).toBeUndefined();
  });

  it("applies hidden keys before replay payloads reach storage", async () => {
    const { runtime, scope } = await fixture();

    runtime.withRun(scope, () => {
      runtime.replay.record({
        kind: "tool.call.started",
        hiddenKeys: ["content"],
        payload: { input: { content: "private body", path: "visible.txt" } },
      });
    });
    await runtime.flush();

    expect(await new TraceQueryService(runtime.store).replay("session", "run")).toMatchObject([
      {
        payload: { input: { content: "[REDACTED]", path: "visible.txt" } },
      },
    ]);
  });

  it("enforces private directory and file permissions", async () => {
    const { runtime, scope } = await fixture();
    runtime.withRun(scope, () => {
      runtime.replay.record({ kind: "user.input", payload: { text: "private" } });
    });
    await runtime.flush();

    expect((await stat(runtime.store.layout.agentRoot())).mode & 0o777).toBe(0o700);
    expect((await stat(runtime.store.layout.runRoot("session", "run"))).mode & 0o777).toBe(0o700);
    expect((await stat(runtime.store.layout.replayPath("session", "run"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("fails open when a run cannot be created and preserves the existing run", async () => {
    const { runtime } = await fixture();

    expect(await runtime.beginRun("session", "run")).toBeUndefined();
    expect(await runtime.beginRun("../invalid", "other-run")).toBeUndefined();
    expect(await new TraceQueryService(runtime.store).run("session", "run")).toMatchObject({
      status: "running",
    });
  });

  it("keeps capture failures isolated when the diagnostic observer also fails", async () => {
    const globalDirectory = await mkdtemp(join(tmpdir(), "omni-trace-diagnostic-"));
    directories.push(globalDirectory);
    const runtime = new AgentScopedTraceRuntime({
      globalDirectory,
      agentId: "coding",
      workspaceId: "workspace",
      cwd: "/workspace",
      onDiagnostic: () => {
        throw new Error("observer failed");
      },
    });
    runtime.control.start();

    await expect(runtime.beginRun("../invalid", "run")).resolves.toBeUndefined();
  });

  it("reads JSONL incrementally by stable byte cursor and ignores an incomplete tail", async () => {
    const { runtime } = await fixture();
    const path = join(runtime.store.layout.agentRoot(), "cursor-test.jsonl");
    await appendFile(path, `${JSON.stringify({ value: 1 })}\n${JSON.stringify({ value: 2 })}\n`);

    const first = await readJsonLinesChunk<{ value: number }>(path, 0, 1);
    const second = await readJsonLinesChunk<{ value: number }>(path, first.cursor, 10);
    await appendFile(path, '{"value":3');
    const incomplete = await readJsonLinesChunk<{ value: number }>(path, second.cursor, 10);

    expect(first.entries.map((entry) => entry.value)).toEqual([{ value: 1 }]);
    expect(second.entries.map((entry) => entry.value)).toEqual([{ value: 2 }]);
    expect(incomplete).toEqual({ entries: [], cursor: second.cursor });
  });

  it("rejects symbolic links inside the trace storage root", async () => {
    const { runtime } = await fixture();
    const external = join(runtime.store.layout.tracesRoot, "external");
    await mkdir(external);
    await symlink(external, runtime.store.layout.sessionRoot("linked"));

    expect(await runtime.beginRun("linked", "run")).toBeUndefined();
    await expect(readFile(join(external, "run", "manifest.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("isolates physical storage by Agent and completes manifests", async () => {
    const coding = await fixture("coding");
    const financial = new AgentScopedTraceRuntime({
      globalDirectory: coding.root,
      agentId: "financial-analysis",
      workspaceId: "workspace",
      cwd: coding.root,
    });
    financial.control.start();
    const financialScope = await financial.beginRun("session", "run");
    if (!financialScope) throw new Error("Financial trace scope was not created");

    await coding.runtime.completeRun(coding.scope, "completed");
    await financial.completeRun(financialScope, "cancelled");

    const codingManifest = JSON.parse(
      await readFile(coding.runtime.store.layout.manifestPath("session", "run"), "utf8"),
    ) as { status: string; agentId: string };
    const financialManifest = JSON.parse(
      await readFile(financial.store.layout.manifestPath("session", "run"), "utf8"),
    ) as { status: string; agentId: string };
    expect(codingManifest).toMatchObject({ status: "completed", agentId: "coding" });
    expect(financialManifest).toMatchObject({
      status: "cancelled",
      agentId: "financial-analysis",
    });
    expect(coding.runtime.store.layout.agentRoot()).not.toBe(financial.store.layout.agentRoot());
  });

  it("rebuilds session summaries from manifests when the append-only index is incomplete", async () => {
    const { runtime, scope } = await fixture();
    await runtime.completeRun(scope, "completed");
    const nextScope = await runtime.beginRun("session", "next-run");
    if (!nextScope) throw new Error("Second Trace scope was not created");
    await runtime.completeRun(nextScope, "completed");

    const indexPath = runtime.store.layout.indexPath();
    const [firstRecord] = (await readFile(indexPath, "utf8")).trim().split("\n");
    await writeFile(indexPath, `${firstRecord}\n`);

    expect(await new TraceQueryService(runtime.store).sessions()).toMatchObject([
      { sessionId: "session", runs: 2 },
    ]);
  });

  it("marks a completed run as degraded when queued records are dropped", async () => {
    const { runtime, scope } = await fixture("coding", 2);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes = (runtime as unknown as { writes: BoundedTraceWriteQueue }).writes;
    writes.enqueue(async () => blocked, "critical");

    runtime.withRun(scope, () => {
      runtime.replay.record({ kind: "run.detail.one", payload: { value: 1 } });
      runtime.replay.record({ kind: "run.detail.two", payload: { value: 2 } });
    });
    release?.();
    await runtime.completeRun(scope, "completed");

    await expect(new TraceQueryService(runtime.store).run("session", "run")).resolves.toMatchObject(
      {
        summary: { capture: { degraded: true, droppedRecords: 1 } },
      },
    );
  });

  it("refuses to clear a live capture and clears completed data", async () => {
    const { runtime, scope } = await fixture();

    expect(await runtime.store.activeRunCount()).toBe(1);
    await expect(runtime.store.clear()).rejects.toThrow("Trace capture is active");
    await runtime.completeRun(scope, "completed");
    expect(await runtime.store.activeRunCount()).toBe(0);
    await runtime.store.clear();

    expect(await new TraceQueryService(runtime.store).sessions()).toEqual([]);
  });

  it("bounds pending writes and preserves critical records under pressure", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: string[] = [];
    const diagnostics: string[] = [];
    const queue = new BoundedTraceWriteQueue({
      capacity: 2,
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(
      queue.enqueue(async () => {
        await blocked;
        written.push("active");
      }, "critical"),
    ).toBe(true);
    expect(
      queue.enqueue(async () => {
        written.push("detail");
      }, "detail"),
    ).toBe(true);
    expect(queue.enqueue(async () => undefined, "detail")).toBe(false);
    expect(
      queue.enqueue(async () => {
        written.push("terminal");
      }, "critical"),
    ).toBe(true);

    release?.();
    await queue.flush();

    expect(written).toEqual(["active", "terminal"]);
    expect(diagnostics).toHaveLength(1);

    let releaseCritical: (() => void) | undefined;
    const criticalBlocked = new Promise<void>((resolve) => {
      releaseCritical = resolve;
    });
    const criticalWritten: string[] = [];
    const criticalQueue = new BoundedTraceWriteQueue({ capacity: 2 });
    criticalQueue.enqueue(async () => criticalBlocked, "critical");
    criticalQueue.enqueue(async () => {
      criticalWritten.push("older");
    }, "critical");
    expect(
      criticalQueue.enqueue(async () => {
        criticalWritten.push("latest");
      }, "critical"),
    ).toBe(true);

    releaseCritical?.();
    await criticalQueue.flush();
    expect(criticalWritten).toEqual(["latest"]);
  });

  it("checks trace path boundaries with host-specific path semantics", () => {
    const boundary = "C:\\Users\\test\\.omni-agent\\traces\\coding";

    expect(isPathWithin(win32.join(boundary, "session", "run"), boundary, win32)).toBe(true);
    expect(isPathWithin("C:\\Users\\test\\.omni-agent\\traces\\other", boundary, win32)).toBe(
      false,
    );
  });
});
