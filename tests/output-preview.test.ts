import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionArtifactStore } from "../packages/app/src/persistence/session-artifact-store";
import { ToolInvocationRunner } from "../packages/core/src/execution/tool-invocation-runner";
import { createAuthorizedToolCall } from "../packages/core/src/execution/authorized-tool-call";
import { retainToolOutput } from "../packages/core/src/execution/tool-output-retention";
import { TextOutputPreview } from "../packages/core/src/execution/text-output-preview";
import { runHostProcess } from "../packages/tools/src/process/host-process-runner";
import { bashTool } from "../packages/tools/src/shell/bash";
import { outputReadTool } from "../packages/tools/src/output/output-read";
import { isProcessTool, isInProcessTool } from "../packages/core/src/types";
import { createToolResultMessage } from "../packages/core/src/session/factory";
import { toBackendMessages } from "../packages/models/src/runtime/message-mapper";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const text = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

it.each(["stdout", "stderr"])(
  "keeps %s failure visible through process, retention and model projection without re-execution",
  async (part) => {
    const root = await mkdtemp(join(tmpdir(), "omni-preview-"));
    roots.push(root);
    const counter = join(root, "count");
    const script = join(root, "emit.cjs");
    await writeFile(
      script,
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x');fs.writeSync(1,'start\\n'+'normal line\\n'.repeat(3000));setTimeout(()=>{fs.writeSync(${part === "stdout" ? 1 : 2},'FAILURE_SENTINEL\\n');process.exitCode=7},40)`,
    );
    const store = new SessionArtifactStore(root);
    await store.withSession("one", async (outputs) => {
      if (!isProcessTool(bashTool) || !isInProcessTool(outputReadTool))
        throw new Error("Wrong tool kind");
      const input = { command: `${quote(process.execPath)} ${quote(script)}` };
      const context = { cwd: root, outputs };
      const invocation = await bashTool.createProcessInvocation(input, context);
      const call = createAuthorizedToolCall(
        { ...bashTool, originId: "test", toolIdentity: "test:bash" },
        input,
        context,
        { mode: "unrestricted", process: { route: "host", invocation } },
      );
      const runner = new ToolInvocationRunner({
        processRouter: {
          run: (plan, signal, output) => runHostProcess({ ...plan.invocation, signal, output }),
        },
      });
      const { result } = await runner.invoke(call, [], { toolCallId: "probe" });
      const projected = toBackendMessages([
        createToolResultMessage("probe", "bash", result.content, result.isError),
      ]);
      expect(JSON.stringify(projected)).toContain("FAILURE_SENTINEL");
      expect(text(result)).toContain("Exit code: 7");
      expect(text(result)).toContain("truncated");
      expect(result.isError).toBe(true);
      expect(result.meta?.outputSource).toBeUndefined();
      const record = result.meta!.output!;
      expect(record.state).toBe("complete");
      expect(record.parts.map((p) => p.label).sort()).toEqual(
        part === "stdout" ? ["stdout"] : ["stderr", "stdout"],
      );
      const page = await outputReadTool.execute(
        { outputId: record.id, partId: record.parts.find((p) => p.label === part)!.id, tail: 2 },
        context,
      );
      expect(text(page)).toContain("FAILURE_SENTINEL");
      expect(await readFile(counter, "utf8")).toBe("x");
    });
  },
);

it("retains independent attachments and rejects invalid preview provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-preview-"));
  roots.push(root);
  await new SessionArtifactStore(root, {
    previewBytes: 100,
    callBytes: 10000,
    sessionBytes: 20000,
  }).withSession("one", async (session) => {
    const writer = await session.create("valid");
    const body = await writer.createPart({ label: "body", mediaType: "text/plain" });
    await body.append("original");
    const result = await retainToolOutput(
      {
        content: [
          {
            type: "text",
            text: "preview",
            outputSource: { outputId: writer.id, partIds: [body.id] },
          },
          { type: "text", text: "independent".repeat(100) },
        ],
        isError: false,
      },
      { session, writer, toolCallId: "valid" },
    );
    expect(result.meta!.output!.parts.map((p) => p.label)).toEqual(["body", "content-1"]);
    for (const entry of [
      { outputId: "wrong", partIds: [body.id] },
      { outputId: writer.id, partIds: ["missing"] },
      { outputId: writer.id, partIds: [body.id, body.id] },
    ]) {
      const failed = await retainToolOutput(
        {
          content: [{ type: "text", text: "preview", outputSource: entry }],
          isError: true,
        },
        { session, writer, toolCallId: "valid" },
      );
      expect(failed.meta?.outputPersistence).toBe("failed");
      expect(failed.meta?.output).toBeUndefined();
      expect(failed.meta?.outputSource).toBeUndefined();
      expect(JSON.stringify(failed.content)).not.toContain("outputSource");
      expect(failed.isError).toBe(true);
    }
  });
});

it("keeps UTF8 boundaries and the byte budget across streaming chunks", () => {
  const original = Buffer.from("开头" + "中间🙂".repeat(100) + "结尾");
  for (const budget of [0, 1, 2, 3, 50, 101, original.length]) {
    const preview = new TextOutputPreview(budget);
    for (let i = 0; i < original.length; i += 7) preview.append(original.subarray(i, i + 7));
    const value = preview.text();
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(budget);
    expect(value).not.toContain("�");
    if (budget >= 50) {
      expect(value).toContain("开头");
      expect(value).toContain("结尾");
    }
  }
});

it.each(["disabled", "create-failure", "finish-failure", "quota"])(
  "preserves status and bounded preview when retention is %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "omni-preview-"));
    roots.push(root);
    const store = new SessionArtifactStore(root, {
      previewBytes: 200,
      callBytes: mode === "quota" ? 50 : 10000,
      sessionBytes: 20000,
    });
    await store.withSession("one", async (bound) => {
      const outputs =
        mode === "disabled"
          ? undefined
          : {
              ...bound,
              async create(id: string, signal?: AbortSignal) {
                if (mode === "create-failure") throw new Error("unavailable");
                const writer = await bound.create(id, signal);
                return mode === "finish-failure"
                  ? {
                      ...writer,
                      async finish() {
                        throw new Error("unavailable");
                      },
                    }
                  : writer;
              },
            };
      if (!isProcessTool(bashTool)) throw new Error("Wrong tool kind");
      const script = join(root, "emit.cjs");
      await writeFile(
        script,
        "require('fs').writeSync(1,'x'.repeat(20000)+'FINAL_FAILURE');process.exitCode=7",
      );
      const context = { cwd: root, outputs };
      const input = { command: `${quote(process.execPath)} ${quote(script)}` };
      const invocation = await bashTool.createProcessInvocation(input, context);
      const call = outputs ? { session: outputs, toolCallId: "failure" } : undefined;
      const raw = await runHostProcess({ ...invocation, output: call });
      const result = await retainToolOutput(
        await bashTool.createToolResult(raw, input, context),
        call,
      );
      expect(text(result)).toContain("Exit code: 7");
      expect(text(result)).toContain("FINAL_FAILURE");
      expect(result.isError).toBe(true);
      expect(result.meta?.outputSource).toBeUndefined();
      if (mode.includes("failure")) {
        expect(result.meta?.outputPersistence).toBe("failed");
        expect(result.meta?.output).toBeUndefined();
      }
      if (mode === "quota") {
        expect(result.meta?.output?.state).toBe("incomplete");
        expect(result.meta?.output?.parts.map((p) => p.label)).toEqual(["stdout"]);
      }
    });
  },
);

it("keeps machine-readable process prefixes unchanged and reserves both human stream previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-preview-"));
  roots.push(root);
  const args = [
    "-e",
    "const fs=require('fs');fs.writeSync(1,'A'.repeat(2000)+'END_OUT');fs.writeSync(2,'B'.repeat(2000)+'END_ERR')",
  ];
  const prefix = await runHostProcess({
    command: process.execPath,
    args,
    cwd: root,
    maxOutputBytes: 200,
  });
  expect(prefix.stdout).toBe("A".repeat(200));
  const display = await runHostProcess({
    command: process.execPath,
    args,
    cwd: root,
    maxOutputBytes: 200,
    outputPreview: "head-tail",
  });
  expect(display.stdout).toContain("END_OUT");
  expect(display.stderr).toContain("END_ERR");
  expect(Buffer.byteLength(display.stdout) + Buffer.byteLength(display.stderr)).toBeLessThanOrEqual(
    200,
  );
});

it("does not publish preview sources from another Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-preview-"));
  roots.push(root);
  const store = new SessionArtifactStore(root);
  await store.withSession("first", async (first) => {
    const writer = await first.create("same-call-id");
    const body = await writer.createPart({ label: "body", mediaType: "text/plain" });
    await body.append("private");
    await store.withSession("second", async (session) => {
      const result = await retainToolOutput(
        {
          content: [
            {
              type: "text",
              text: "preview",
              outputSource: { outputId: writer.id, partIds: [body.id] },
            },
          ],
          isError: false,
        },
        { session, writer, toolCallId: "same-call-id" },
      );
      expect(result.meta?.outputPersistence).toBe("failed");
      expect(result.meta?.output).toBeUndefined();
    });
  });
});

it.each([false, true])(
  "shares one independent-text budget when storage failure is %s",
  async (failStorage) => {
    const root = await mkdtemp(join(tmpdir(), "omni-preview-budget-"));
    roots.push(root);
    await new SessionArtifactStore(root).withSession("one", async (bound) => {
      const session = failStorage
        ? {
            ...bound,
            async create() {
              throw new Error("unavailable");
            },
          }
        : bound;
      const bodies = Array.from(
        { length: 50 },
        (_, index) => `block-${index}\n` + "x".repeat(8990),
      );
      const result = await retainToolOutput(
        { content: bodies.map((body) => ({ type: "text", text: body })), isError: false },
        { session, toolCallId: "many" },
      );
      const visibleBodyBytes = result.content
        .slice(0, bodies.length)
        .reduce((sum, part) => sum + Buffer.byteLength(part.text!.split("\nSaved output:")[0]!), 0);
      expect(visibleBodyBytes).toBeLessThanOrEqual(session.previewBytes);
      expect(result.isError).toBe(false);
      if (failStorage) {
        expect(result.meta?.outputPersistence).toBe("failed");
        expect(result.meta?.output).toBeUndefined();
      } else {
        const record = result.meta!.output!;
        expect(record.parts).toHaveLength(50);
        expect(record.parts.reduce((sum, part) => sum + part.bytes, 0)).toBe(
          bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0),
        );
        for (const index of [0, 49]) {
          const page = await session.read({
            outputId: record.id,
            partId: record.parts.find((p) => p.label === `content-${index}`)!.id,
            limit: 2,
          });
          expect(page.text).toContain(`block-${index}`);
          expect(page.text).toContain("x".repeat(8990));
        }
      }
    });
  },
);

it("budgets structured and text content together without fragmenting JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-preview-budget-"));
  roots.push(root);
  await new SessionArtifactStore(root, {
    previewBytes: 1024,
    callBytes: 10000,
    sessionBytes: 20000,
  }).withSession("one", async (session) => {
    const structuredContent = { value: "y".repeat(700) };
    const result = await retainToolOutput(
      { content: [{ type: "text", text: "x".repeat(700) }], structuredContent, isError: false },
      { session, toolCallId: "mixed" },
    );
    expect(result.content[0]!.text).toBe("x".repeat(700));
    expect(result.structuredContent).toBeUndefined();
    expect(result.meta?.structuredOutputPart).toBe(
      result.meta!.output!.parts.find((p) => p.label === "structured")!.id,
    );
    const page = await session.read({
      outputId: result.meta!.output!.id,
      partId: result.meta!.structuredOutputPart!,
      limit: 1,
    });
    expect(page.text).toContain(JSON.stringify(structuredContent));
  });
});

it.each(["limit", "interrupted"])(
  "keeps %s readback status visible through retention and model projection",
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), "omni-preview-readback-"));
    roots.push(root);
    await new SessionArtifactStore(root, {
      previewBytes: 100,
      callBytes: state === "limit" ? 12 : 1000,
      sessionBytes: 2000,
    }).withSession("one", async (session) => {
      const writer = await session.create("capture");
      const stream = await writer.createPart({ label: "stdout", mediaType: "text/plain" });
      await stream.append("START\n".repeat(20) + "END\n");
      const record = await writer.finish({ interrupted: state === "interrupted" });
      if (!isInProcessTool(outputReadTool)) throw new Error("Wrong tool kind");
      const page = await outputReadTool.execute(
        { outputId: record.id, partId: stream.id, tail: 2 },
        { cwd: root, outputs: session },
      );
      const retained = await retainToolOutput(page, { session, toolCallId: "read" });
      const projected = toBackendMessages([
        createToolResultMessage("read", "output_read", retained.content, retained.isError),
      ]);
      expect(retained.isError).toBe(false);
      expect(JSON.stringify(projected)).toContain(record.state);
      expect(text(retained)).toContain("retained bytes");
      expect(text(retained)).toContain("Lines:");
      expect(retained.meta!.outputRead!.outputId).toBe(record.id);
    });
  },
);

it.each(["prepend", "reorder", "clone", "replace", "remove"])(
  "keeps preview provenance block-local through %s middleware, cloning and redaction",
  async (mutation) => {
    const root = await mkdtemp(join(tmpdir(), "omni-output-binding-"));
    roots.push(root);
    await new SessionArtifactStore(root, {
      previewBytes: 200,
      callBytes: 10000,
      sessionBytes: 20000,
    }).withSession("one", async (outputs) => {
      const tool: import("../packages/core/src/types").RegisteredAgentTool = {
        name: "capture",
        originId: "test",
        toolIdentity: "test:capture",
        description: "test capture",
        schema: {},
        access: { kind: "internal" },
        execution: { kind: "in_process" },
        timeout: { kind: "none" },
        async execute(_input, context) {
          const call = context.outputCall!;
          const writer = await context.outputs!.create(call.toolCallId);
          call.writer = writer;
          const body = await writer.createPart({ label: "body", mediaType: "text/plain" });
          await body.append("original captured body");
          return {
            content: [
              {
                type: "text",
                text: "preview private-value",
                outputSource: { outputId: writer.id, partIds: [body.id] },
              },
            ],
            isError: false,
          };
        },
      };
      const runner = new ToolInvocationRunner({
        processRouter: {
          async run() {
            throw new Error("Unexpected process");
          },
        },
      });
      const call = createAuthorizedToolCall(
        tool,
        {},
        { cwd: root, outputs },
        { mode: "unrestricted", sensitiveValues: { exactValues: ["private-value"] } },
      );
      const attachment = "independent private-value " + "x".repeat(700);
      const { result } = await runner.invoke(
        call,
        [
          {
            afterExecute(_context, result) {
              result.content = structuredClone(result.content);
              expect(result.content[0]!.text).not.toContain("private-value");
              if (mutation === "prepend" || mutation === "reorder") {
                result.content.unshift({ type: "text", text: attachment });
                if (mutation === "reorder") result.content.reverse();
              } else if (mutation === "clone") {
                result.content.push(structuredClone(result.content[0]!));
              } else if (mutation === "replace") {
                result.content[0] = { type: "text", text: attachment };
              } else {
                result.content.shift();
              }
            },
          },
        ],
        { toolCallId: mutation },
      );
      const record = result.meta!.output!;
      expect(record.state).toBe("complete");
      expect(record.parts.filter((part) => part.label === "body")).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("private-value");
      expect(JSON.stringify(result.content)).not.toContain("outputSource");
      const projected = toBackendMessages([
        createToolResultMessage("result", "capture", result.content, result.isError),
      ]);
      expect(JSON.stringify(projected)).not.toContain("outputSource");
      const independent = record.parts.filter((part) => part.label !== "body");
      if (["prepend", "reorder", "replace"].includes(mutation)) {
        expect(independent).toHaveLength(1);
        const page = await outputs.read({ outputId: record.id, partId: independent[0]!.id });
        expect(page.text).toContain("independent [REDACTED]");
        expect(page.text).toContain("x".repeat(700));
      } else {
        expect(independent).toHaveLength(0);
      }
    });
  },
);
