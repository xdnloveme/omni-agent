import { fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { InterprocessFileLock } from "../packages/core/src/persistence/interprocess-file-lock";
import {
  NOOP_RUNTIME_EXECUTION_OBSERVATION,
  type RuntimeExecutionCancelledFact,
} from "../packages/core/src/runtime-observation";
import { createToolResultMessage } from "../packages/core/src/session/factory";
import { toBackendMessages } from "../packages/models/src/runtime/message-mapper";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, readdir, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionArtifactStore } from "../packages/app/src/persistence/session-artifact-store";
import { retainToolOutput } from "../packages/core/src/execution/tool-output-retention";
import { runHostProcess } from "../packages/tools/src/process/host-process-runner";
import { outputReadTool } from "../packages/tools/src/output/output-read";
import { ToolInvocationRunner } from "../packages/core/src/execution/tool-invocation-runner";
import { createAuthorizedToolCall } from "../packages/core/src/execution/authorized-tool-call";
import type { OutputCallContext, OutputRecord } from "../packages/core/src/execution/output";
import type { RegisteredAgentTool } from "../packages/core/src/types";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(callBytes = 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), "omni-output-"));
  directories.push(root);
  return {
    root,
    store: new SessionArtifactStore(root, {
      previewBytes: 1024,
      callBytes,
      sessionBytes: callBytes * 2,
    }),
  };
}

describe("Session output retention", () => {
  it("executes once, retains beyond preview, redacts across chunks and reopens without Trace", async () => {
    const { root, store } = await setup();
    let record!: OutputRecord;
    const counter = join(root, "counter");
    await store.withSession("one", async (session) => {
      const output: OutputCallContext = {
        session,
        toolCallId: "call",
        sensitive: { exactValues: ["secret-token"] },
      };
      const command = `require('fs').appendFileSync(${JSON.stringify(counter)},'x'); process.stdout.write('secret-'); setTimeout(()=>{process.stdout.write('token\\n'+ 'prefix\\n'.repeat(2000)+'LAST-LINE\\n');process.stderr.write('stderr-line\\n');process.exitCode=7},20)`;
      const result = await runHostProcess({
        command: process.execPath,
        args: ["-e", command],
        cwd: root,
        maxOutputBytes: 1024,
        output,
      });
      expect(result.exitCode).toBe(7);
      expect(result.stdoutTruncated).toBe(true);
      const retained = await retainToolOutput(
        { content: [{ type: "text", text: result.stdout }], isError: true },
        output,
      );
      record = retained.meta!.output!;
      expect(record.state).toBe("complete");
      const page = await session.read({
        outputId: record.id,
        partId: record.parts.find((p) => p.label === "stdout")!.id,
        tail: 2,
      });
      expect(page.text).toContain("LAST-LINE");
      const head = await session.read({
        outputId: record.id,
        partId: record.parts.find((p) => p.label === "stdout")!.id,
        limit: 2,
      });
      expect(head.text).toContain("[REDACTED]");
      expect(head.text).not.toContain("secret-token");
    });
    await store.withSession("one", async (session) => {
      await session.resolve({ outputId: record.id });
      expect(
        (
          await session.read({
            outputId: record.id,
            partId: record.parts.find((p) => p.label === "stdout")!.id,
            tail: 2,
          })
        ).text,
      ).toContain("LAST-LINE");
    });
    expect(await readFile(counter, "utf8")).toBe("x");
    await store.withSession("two", async (session) => {
      await expect(session.resolve({ outputId: record.id })).rejects.toThrow();
    });
  });

  it("retains arbitrary successful and failed in-process outputs, and does not offload read pages again", async () => {
    const { root, store } = await setup();
    await store.withSession("one", async (session) => {
      for (const isError of [false, true]) {
        const result = await retainToolOutput(
          { content: [{ type: "text", text: "line\n".repeat(2000) }], isError },
          { session, toolCallId: String(isError) },
        );
        expect(result.isError).toBe(isError);
        const record = result.meta!.output!;
        if (outputReadTool.execution.kind !== "in_process")
          throw new Error("Expected internal reader");
        const page = await outputReadTool.execute(
          {
            outputId: record.id,
            partId: record.parts.find((p) => p.label === "content-0")!.id,
            limit: 5,
          },
          { cwd: root, outputs: session },
        );
        const before = await readdir(join(root, "one"));
        const retainedPage = await retainToolOutput(page, { session, toolCallId: "read" });
        expect(retainedPage.meta!.outputRead!.outputId).toBe(record.id);
        expect(await readdir(join(root, "one"))).toEqual(before);
      }
    });
  });

  it("keeps incomplete quota-limited records truthful and preserves the caller's result", async () => {
    const { store } = await setup(32);
    await store.withSession("one", async (session) => {
      const result = await retainToolOutput(
        { content: [{ type: "text", text: "large".repeat(500) }], isError: false },
        { session, toolCallId: "quota" },
      );
      expect(result.isError).toBe(false);
      expect(result.meta!.output!.state).toBe("incomplete");
      expect(result.meta!.output!.reason).toBe("limit");
      const page = await session.read({
        outputId: result.meta!.output!.id,
        partId: result.meta!.output!.parts.find((p) => p.label === "content-0")!.id,
      });
      expect(page.record.parts[0]!.bytes).toBe(32);
    });
  });

  it("keeps middleware before presentation and applies its sensitive values before persistence", async () => {
    const { root, store } = await setup();
    await store.withSession("one", async (outputs) => {
      const tool: RegisteredAgentTool = {
        name: "arbitrary",
        description: "test",
        schema: {},
        originId: "test",
        toolIdentity: "test:arbitrary",
        access: { kind: "internal" },
        execution: { kind: "in_process" },
        timeout: { kind: "none" },
        async execute() {
          return { content: [{ type: "text", text: "x".repeat(2000) }], isError: false };
        },
      };
      const call = createAuthorizedToolCall(
        tool,
        {},
        { cwd: root, outputs },
        { mode: "unrestricted", sensitiveValues: { exactValues: ["private-value"] } },
      );
      const runner = new ToolInvocationRunner({
        processRouter: {
          async run() {
            throw new Error("Unexpected process");
          },
        },
      });
      const result = await runner.invoke(
        call,
        [
          {
            afterExecute(_context, result) {
              expect(result.content[0]!.text!.length).toBe(2000);
              result.content[0] = { type: "text", text: result.content[0]!.text + "private-value" };
            },
          },
        ],
        { toolCallId: "middleware" },
      );
      const record = result.result.meta!.output!;
      const page = await outputs.read({
        outputId: record.id,
        partId: record.parts.find((p) => p.label === "content-0")!.id,
      });
      expect(page.text).toContain("[REDACTED]");
      expect(page.text).not.toContain("private-value");
    });
  });

  it("rejects late writes, clears under the Session lease and detects changed saved content", async () => {
    const { root, store } = await setup();
    let late!: () => Promise<void>;
    let id = "";
    let bodyId = "";
    await store.withSession("one", async (session) => {
      const writer = await session.create("once");
      id = writer.id;
      const body = await writer.createPart({ label: "body", mediaType: "text/plain" });
      bodyId = body.id;
      await body.append("original\n");
      await writer.finish();
      late = () => body.append("late");
      await expect(late()).rejects.toThrow("finalized");
      await writeFile(join(root, "one", `${id}.${bodyId}.data`), "changed\n");
      await expect(session.read({ outputId: id, partId: bodyId })).rejects.toThrow("integrity");
    });
    await expect(late()).rejects.toThrow("lease");
    await store.clear("one", async () => {});
    await store.withSession("one", async (session) => {
      await expect(session.read({ outputId: id, partId: bodyId })).rejects.toThrow();
    });
  });
  it("preserves structured and multimodal semantics through references and relocatable storage", async () => {
    const { root, store } = await setup();
    let record!: OutputRecord;
    await store.withSession("one", async (session) => {
      const value = { rows: Array.from({ length: 1000 }, (_, index) => ({ index })) };
      const result = await retainToolOutput(
        {
          content: [{ type: "image", data: "base64", mimeType: "image/png" }],
          structuredContent: value,
          isError: false,
        },
        { session, toolCallId: "structured" },
      );
      expect(result.content[0]).toEqual({ type: "image", data: "base64", mimeType: "image/png" });
      expect(result.structuredContent).toBeUndefined();
      record = result.meta!.output!;
      expect(record.parts[0]!.mediaType).toBe("application/json");
      expect(
        await readFile(
          join(
            root,
            "one",
            `${record.id}.${record.parts.find((p) => p.label === "structured")!.id}.data`,
          ),
          "utf8",
        ),
      ).toBe(JSON.stringify(value));
    });
    const moved = await mkdtemp(join(tmpdir(), "omni-output-moved-"));
    directories.push(moved);
    await cp(join(root, "one"), join(moved, "one"), { recursive: true });
    await new SessionArtifactStore(moved).withSession("one", async (session) => {
      await session.resolve({ outputId: record.id });
      expect(
        (
          await session.read({
            outputId: record.id,
            partId: record.parts.find((p) => p.label === "structured")!.id,
          })
        ).text,
      ).toContain('"rows"');
      await rm(
        join(
          moved,
          "one",
          `${record.id}.${record.parts.find((p) => p.label === "structured")!.id}.data`,
        ),
      );
      await expect(
        session.read({
          outputId: record.id,
          partId: record.parts.find((p) => p.label === "structured")!.id,
        }),
      ).rejects.toThrow();
    });
  });

  it("seals cancelled output as interrupted and never changes cancellation to success", async () => {
    const { root, store } = await setup();
    await store.withSession("one", async (session) => {
      const controller = new AbortController();
      const writer = await session.create("cancel");
      const output: OutputCallContext = {
        session,
        toolCallId: "cancel",
        writer: {
          id: writer.id,
          finish: (options) => writer.finish(options),
          async createPart(options, signal) {
            const part = await writer.createPart(options, signal);
            return {
              id: part.id,
              async append(text, signal) {
                await part.append(text, signal);
                // Cancel after real persistence, not an assumed process startup delay.
                if (options.label === "stdout") controller.abort();
              },
            };
          },
        },
      };
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        await expect(
          runHostProcess({
            command: process.execPath,
            args: ["-e", "process.stdout.write('before-cancel\\n'); setInterval(()=>{},1000)"],
            cwd: root,
            maxOutputBytes: 1024,
            signal: controller.signal,
            output,
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        clearTimeout(timer);
      }
      const record = await output.writer!.finish({ interrupted: true });
      expect(record.state).toBe("interrupted");
      expect(
        (
          await session.read({
            outputId: record.id,
            partId: record.parts.find((p) => p.label === "stdout")!.id,
          })
        ).text,
      ).toContain("before-cancel");
    });
  });

  it("rejects clear while a Session lease is active and recovers unfinished output", async () => {
    const { store } = await setup();
    let id = "";
    let bodyId = "";
    await store.withSession("one", async (session) => {
      const writer = await session.create("unfinished");
      id = writer.id;
      const body = await writer.createPart({ label: "body", mediaType: "text/plain" });
      bodyId = body.id;
      await body.append("saved-before-interruption\n");
      await expect(
        store.clear("one", async () => {
          throw new Error("Must not clear");
        }),
      ).rejects.toThrow("Timed out waiting");
    });
    await store.withSession("one", async (session) => {
      const page = await session.read({ outputId: id, partId: bodyId });
      expect(page.record.state).toBe("interrupted");
      expect(page.record.reason).toBe("abandoned");
      expect(page.record.parts[0]!.observedBytes).toBeGreaterThanOrEqual(
        page.record.parts[0]!.bytes,
      );
      expect(page.text).toContain("saved-before-interruption");
    });
  });
});

it("marks non-UTF8 process output incomplete without changing process success", async () => {
  const { root, store } = await setup();
  await store.withSession("binary", async (session) => {
    const output: OutputCallContext = { session, toolCallId: "binary" };
    const processResult = await runHostProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.from([65,255,66]))"],
      cwd: root,
      maxOutputBytes: 1024,
      output,
    });
    expect(processResult.exitCode).toBe(0);
    const result = await retainToolOutput(
      { content: [{ type: "text", text: processResult.stdout }] },
      output,
    );
    expect(result.meta?.output?.state).toBe("incomplete");
    expect(result.meta?.output?.reason).toBe("unsupported_content");
    expect(result.isError).toBeUndefined();
  });
});

it("uses the advertised continuation parameters for a long saved line", async () => {
  const { root, store } = await setup();
  await store.withSession("long", async (session) => {
    const result = await retainToolOutput(
      { content: [{ type: "text", text: "x".repeat(70000) + "FINAL" }] },
      { session, toolCallId: "long" },
    );
    if (outputReadTool.execution.kind !== "in_process") throw new Error("Expected reader");
    const input = {
      outputId: result.meta!.output!.id,
      partId: result.meta!.output!.parts.find((p) => p.label === "content-0")!.id,
    };
    const first = await outputReadTool.execute(input, { cwd: root, outputs: session });
    const body = first.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    const continuation = /offset=(\d+), line_byte_offset=(\d+), file_version="([^"]+)"/.exec(body)!;
    expect(continuation).not.toBeNull();
    const second = await outputReadTool.execute(
      {
        ...input,
        offset: Number(continuation[1]),
        line_byte_offset: Number(continuation[2]),
        file_version: continuation[3],
      },
      { cwd: root, outputs: session },
    );
    expect(second.isError).toBe(false);
    expect(JSON.stringify(second.content)).toContain("FINAL");
  });
});

it("keeps the command result and reports lost capture when storage rejects creation", async () => {
  const { root, store } = await setup();
  await store.withSession("failure", async (bound) => {
    const session = {
      ...bound,
      create: async () => {
        throw new Error("storage unavailable");
      },
    };
    const output: OutputCallContext = { session, toolCallId: "failure" };
    const counter = join(root, "attempts");
    const processResult = await runHostProcess({
      command: process.execPath,
      args: [
        "-e",
        `require('fs').appendFileSync(${JSON.stringify(counter)},'x');process.stdout.write('x'.repeat(5000));process.exitCode=7`,
      ],
      cwd: root,
      maxOutputBytes: 1024,
      output,
    });
    const result = await retainToolOutput(
      {
        content: [{ type: "text", text: processResult.stdout }],
        structuredContent: { body: "x".repeat(5000) },
        isError: true,
      },
      output,
    );
    expect(processResult.exitCode).toBe(7);
    expect(await readFile(counter, "utf8")).toBe("x");
    expect(result.isError).toBe(true);
    expect(result.meta?.outputPersistence).toBe("failed");
    expect(result.meta?.output).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain("Output retention failed");
  });
});

it("recovers a killed writer between body and metadata commit without reclaiming a live owner", async () => {
  const { root, store } = await setup();
  const child = fork(new URL("./fixtures/output-crash-writer.mts", import.meta.url), [root], {
    execArgv: ["--import", "tsx"],
    silent: true,
  });
  try {
    const [message] = await once(child, "message");
    const { id, bodyId } = message as { id: string; bodyId: string };
    // An old lease is still live while its owning process exists.
    await delay(31000);
    await expect(
      store.clear("crash", async () => {
        throw new Error("live owner was bypassed");
      }),
    ).rejects.toThrow("Timed out");
    child.kill("SIGKILL");
    await once(child, "exit");
    const orphan = `${randomUUID()}.body.data`;
    const temporary = `${id}.json.123.${randomUUID()}.tmp`;
    await writeFile(join(root, "crash", orphan), "orphan");
    await writeFile(join(root, "crash", temporary), "interrupted atomic write");
    await writeFile(join(root, "crash", "unrelated.txt"), "keep");
    await store.withSession("crash", async (session) => {
      const page = await session.read({ outputId: id, partId: bodyId });
      expect(page.text).toContain("before-crash");
      expect(page.record.state).toBe("interrupted");
      expect(page.record.reason).toBe("abandoned");
      expect(page.record.parts[0]!.observedBytes).toBeGreaterThanOrEqual(
        page.record.parts[0]!.bytes,
      );
      const names = await readdir(join(root, "crash"));
      expect(names).not.toContain(orphan);
      expect(names).not.toContain(temporary);
      expect(names).toContain("unrelated.txt");
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}, 45000);

it("cancels queued writes and reads without admitting late work, and enforces concurrent quotas", async () => {
  const { root, store } = await setup(32);
  await store.withSession("queued", async (session) => {
    const writer = await session.create("one");
    const second = await session.create("two");
    await Promise.all([
      writer
        .createPart({ label: "body", mediaType: "text/plain" })
        .then((part) => part.append("x".repeat(50))),
      second
        .createPart({ label: "body", mediaType: "text/plain" })
        .then((part) => part.append("y".repeat(50))),
    ]);
    const records = await Promise.all([writer.finish(), second.finish()]);
    expect(records.flatMap((r) => r.parts).reduce((n, p) => n + p.bytes, 0)).toBe(64);
    expect(records.every((r) => r.reason === "limit")).toBe(true);
    const pending = await session.create("pending");
    const pendingPart = await pending.createPart({ label: "body", mediaType: "text/plain" });
    await new InterprocessFileLock(join(root, "queued.metadata.lock")).runExclusive(async () => {
      const controller = new AbortController();
      const create = pending.createPart(
        { label: "body", mediaType: "text/plain" },
        controller.signal,
      );
      const read = session.read(
        { outputId: records[0]!.id, partId: records[0]!.parts[0]!.id },
        controller.signal,
      );
      const write = pendingPart.append("late", controller.signal);
      const results = Promise.allSettled([create, write, read]);
      controller.abort();
      expect((await results).every((r) => r.status === "rejected")).toBe(true);
    });
    const final = await pending.finish();
    expect(final.parts).toHaveLength(1);
    expect(final.parts[0]!.bytes).toBe(0);
  });
});

it("seals output and records cancellation when retaining a tool failure is cancelled", async () => {
  const { root, store } = await setup();
  await store.withSession("failure-finalization", async (outputs) => {
    const controller = new AbortController();
    let outputId = "";
    const terminal: string[] = [];
    let cancelled: RuntimeExecutionCancelledFact | undefined;
    const tool: RegisteredAgentTool = {
      name: "retention-probe",
      description: "test",
      schema: {},
      originId: "test",
      toolIdentity: "test:retention-probe",
      access: { kind: "internal" },
      execution: { kind: "in_process" },
      timeout: { kind: "none" },
      async execute(_input, context) {
        const writer = await outputs.create("failure-call");
        outputId = writer.id;
        const part = await writer.createPart({ label: "body", mediaType: "text/plain" });
        await part.append("captured before failure");
        context.outputCall!.writer = {
          ...writer,
          async finish(options) {
            // Cancel at the persistence boundary, after the execution error was caught.
            if (!options?.interrupted) {
              controller.abort();
              throw controller.signal.reason;
            }
            return writer.finish(options);
          },
        };
        throw new Error("original tool failure");
      },
    };
    const call = createAuthorizedToolCall(
      tool,
      {},
      { cwd: root, outputs, signal: controller.signal },
      { mode: "unrestricted", sensitiveValues: { exactValues: [] } },
    );
    const runner = new ToolInvocationRunner({
      processRouter: {
        async run() {
          throw new Error("unexpected process execution");
        },
      },
    });
    await expect(
      runner.invoke(
        call,
        [],
        { toolCallId: "failure-call" },
        {
          ...NOOP_RUNTIME_EXECUTION_OBSERVATION,
          complete() {
            terminal.push("complete");
          },
          timeout() {
            terminal.push("timeout");
          },
          fail() {
            terminal.push("fail");
          },
          cancel(fact) {
            terminal.push("cancel");
            cancelled = fact;
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(terminal).toEqual(["cancel"]);
    expect(cancelled?.output).toMatchObject({ id: outputId, state: "interrupted" });
    expect(cancelled?.outputPersistenceFailure).toBeUndefined();
    // Check before releasing the lease: later recovery must not hide missing cancellation cleanup.
    expect(await outputs.resolve({ outputId })).toMatchObject({ state: "interrupted" });
  });
});

it("reports cancellation sealing failure while preserving cancellation and later recovery", async () => {
  const { root, store } = await setup();
  await store.withSession("cancel-failure", async (outputs) => {
    const controller = new AbortController();
    const tool: RegisteredAgentTool = {
      name: "cancel-test",
      description: "test",
      schema: {},
      originId: "test",
      toolIdentity: "test:cancel-test",
      access: { kind: "internal" },
      execution: { kind: "in_process" },
      timeout: { kind: "none" },
      async execute(_input, context) {
        const writer = await outputs.create("cancel-call");
        const body = await writer.createPart({ label: "body", mediaType: "text/plain" });
        await body.append("saved before cancellation");
        context.outputCall!.writer = {
          ...writer,
          async finish() {
            throw new Error("seal failed");
          },
        };
        controller.abort();
        throw controller.signal.reason;
      },
    };
    const call = createAuthorizedToolCall(
      tool,
      {},
      { cwd: root, outputs, signal: controller.signal },
      { mode: "unrestricted", sensitiveValues: { exactValues: [] } },
    );
    let fact: RuntimeExecutionCancelledFact | undefined;
    const runner = new ToolInvocationRunner({
      processRouter: {
        async run() {
          throw new Error("unexpected");
        },
      },
    });
    await expect(
      runner.invoke(
        call,
        [],
        { toolCallId: "cancel-call" },
        {
          ...NOOP_RUNTIME_EXECUTION_OBSERVATION,
          cancel(value) {
            fact = value;
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fact?.outputPersistenceFailure).toBe("seal failed");
  });
});

it("preserves a large structured result through transcript serialization, provider projection and readback", async () => {
  const { store } = await setup();
  const original = { rows: Array.from({ length: 500 }, (_, i) => ({ index: i, ok: i % 2 === 0 })) };
  await store.withSession("structured-wire", async (session) => {
    const retained = await retainToolOutput(
      { content: [], structuredContent: original, isError: false },
      { session, toolCallId: "json" },
    );
    const transcript = {
      ...createToolResultMessage(
        "json",
        "arbitrary",
        retained.content,
        false,
        retained.structuredContent,
      ),
      details: retained.meta,
    };
    const reopened = JSON.parse(JSON.stringify(transcript));
    const backend = toBackendMessages([reopened]);
    expect(JSON.stringify(backend)).toContain(retained.meta!.output!.id);
    const page = await session.read({
      outputId: reopened.details.output.id,
      partId: reopened.details.structuredOutputPart,
    });
    expect(JSON.parse(page.text.replace(/^1\|/, ""))).toEqual(original);
    expect(backend[0]!.role).toBe("toolResult");
  });
});

it("keeps a missing interrupted body explicit without blocking the next Session run", async () => {
  const { root, store } = await setup();
  let id = "";
  let bodyId = "";
  await store.withSession("missing", async (session) => {
    const writer = await session.create("missing");
    id = writer.id;
    const body = await writer.createPart({ label: "body", mediaType: "text/plain" });
    bodyId = body.id;
    await body.append("captured");
    await rm(join(root, "missing", `${id}.${bodyId}.data`));
  });
  await store.withSession("missing", async (session) => {
    const record = JSON.parse(await readFile(join(root, "missing", `${id}.json`), "utf8"));
    expect(record.state).toBe("incomplete");
    expect(record.reason).toBe("persistence_error");
    await expect(session.read({ outputId: id, partId: bodyId })).rejects.toThrow();
    const next = await session.create("next");
    await (await next.createPart({ label: "body", mediaType: "text/plain" })).append("next run");
    expect((await next.finish()).state).toBe("complete");
  });
});

it("preserves pipeline semantics and UTF8 split across process chunks while capturing", async () => {
  const { root, store } = await setup();
  await store.withSession("process-contract", async (session) => {
    for (const [command, exitCode] of [
      ["false | true", 0],
      ["set -o pipefail; false | true", 1],
    ] as const) {
      const output: OutputCallContext = { session, toolCallId: command };
      const result = await runHostProcess({
        command: "/bin/bash",
        args: ["-c", command],
        cwd: root,
        maxOutputBytes: 1024,
        output,
      });
      expect(result.exitCode).toBe(exitCode);
      await output.writer!.finish();
    }
    const output: OutputCallContext = { session, toolCallId: "utf8" };
    await runHostProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),20)",
      ],
      cwd: root,
      maxOutputBytes: 1024,
      output,
    });
    const record = await output.writer!.finish();
    expect(record.state).toBe("complete");
    expect(
      (
        await session.read({
          outputId: record.id,
          partId: record.parts.find((p) => p.label === "stdout")!.id,
        })
      ).text,
    ).toBe("1|\u4e2d");
  });
});

it("isolates concurrent same-label parts and keeps append/finish ownership in the writer", async () => {
  const { store } = await setup();
  await store.withSession("identity", async (session) => {
    const writer = await session.create("parts");
    const parts = await Promise.all(
      Array.from({ length: 8 }, () =>
        writer.createPart({ label: "same", mediaType: "text/plain" }),
      ),
    );
    expect(new Set(parts.map((p) => p.id)).size).toBe(parts.length);
    await Promise.all(parts.map((part, index) => part.append(`part-${index}`)));
    await parts[0]!.append("-continued");
    const empty = await writer.createPart({ label: "same", mediaType: "text/plain" });
    const record = await writer.finish();
    expect(record.state).toBe("complete");
    for (const [index, part] of parts.entries()) {
      expect((await session.read({ outputId: writer.id, partId: part.id })).text).toBe(
        `1|part-${index}${index === 0 ? "-continued" : ""}`,
      );
    }
    expect(record.parts.find((p) => p.id === empty.id)?.bytes).toBe(0);
    await expect(parts[0]!.append("late")).rejects.toThrow("finalized");
    await expect(writer.createPart({ label: "late", mediaType: "text/plain" })).rejects.toThrow(
      "finalized",
    );
  });
});

it("keeps captured parts distinct from same-label independent text and JSON", async () => {
  const { store } = await setup(10000);
  await store.withSession("collision", async (session) => {
    const writer = await session.create("collision");
    const textPart = await writer.createPart({ label: "content-0", mediaType: "text/plain" });
    const jsonPart = await writer.createPart({ label: "structured", mediaType: "text/plain" });
    await textPart.append("ORIGINAL_TEXT");
    await jsonPart.append("ORIGINAL_JSON");
    const text = "independent".repeat(200);
    const json = { value: "independent-json".repeat(200) };
    const result = await retainToolOutput(
      {
        content: [
          { type: "text", text },
          {
            type: "text",
            text: "preview",
            outputSource: { outputId: writer.id, partIds: [textPart.id, jsonPart.id] },
          },
        ],
        structuredContent: json,
        isError: false,
      },
      { session, toolCallId: "collision", writer },
    );
    const record = result.meta!.output!;
    expect(record.parts).toHaveLength(4);
    expect(new Set(record.parts.map((p) => p.id)).size).toBe(4);
    expect((await session.read({ outputId: writer.id, partId: textPart.id })).text).toBe(
      "1|ORIGINAL_TEXT",
    );
    expect((await session.read({ outputId: writer.id, partId: jsonPart.id })).text).toBe(
      "1|ORIGINAL_JSON",
    );
    const attachment = record.parts.find((p) => p.id !== textPart.id && p.label === "content-0")!;
    expect((await session.read({ outputId: writer.id, partId: attachment.id })).text).toBe(
      `1|${text}`,
    );
    expect(
      (await session.read({ outputId: writer.id, partId: result.meta!.structuredOutputPart! }))
        .text,
    ).toBe(`1|${JSON.stringify(json)}`);
  });
});

it("reads existing version-1 records with name-based IDs and no labels without migration", async () => {
  const { root, store } = await setup();
  const id = randomUUID();
  const text = "historical body\n";
  await store.withSession("history", async () => {});
  const { createHash } = await import("node:crypto");
  await writeFile(join(root, "history", `${id}.stdout.data`), text);
  const record = {
    version: 1,
    id,
    toolCallId: "historical",
    state: "complete",
    parts: [
      {
        id: "stdout",
        mediaType: "text/plain",
        bytes: Buffer.byteLength(text),
        observedBytes: Buffer.byteLength(text),
        complete: true,
        sha256: createHash("sha256").update(text).digest("hex"),
        lines: 1,
        endsWithNewline: true,
      },
    ],
  };
  const path = join(root, "history", `${id}.json`);
  await writeFile(path, JSON.stringify(record));
  const before = await readFile(path, "utf8");
  await store.withSession("history", async (session) => {
    expect((await session.read({ outputId: id, partId: "stdout" })).text).toContain(
      "historical body",
    );
  });
  expect(await readFile(path, "utf8")).toBe(before);
});

it("resolves only finalized session-owned references and shares readback integrity checks", async () => {
  const { root, store } = await setup();
  let reference!: { outputId: string; partId: string };
  await store.withSession("one", async (session) => {
    const writer = await session.create("source");
    const part = await writer.createPart({ label: "display", mediaType: "text/plain" });
    reference = { outputId: writer.id, partId: part.id };
    await part.append("original body");
    await expect(session.resolve(reference)).rejects.toThrow("not been finalized");
    await writer.finish();
    const canonical = await session.resolve(reference);
    expect(canonical.parts[0]!.bytes).toBe(13);
    await expect(session.resolve({ ...reference, partId: "missing" })).rejects.toThrow(
      "does not exist",
    );
    await expect(session.read({ ...reference, partId: "missing" })).rejects.toThrow(
      "does not exist",
    );
    await store.withSession("two", async (other) => {
      await expect(other.resolve(reference)).rejects.toThrow();
    });
    const controller = new AbortController();
    controller.abort();
    await expect(session.resolve(reference, controller.signal)).rejects.toThrow();
    await writeFile(
      join(root, "one", `${reference.outputId}.${reference.partId}.data`),
      "modified body",
    );
    await expect(session.resolve(reference)).rejects.toThrow("integrity");
    await expect(session.read(reference)).rejects.toThrow("integrity");
  });
});
