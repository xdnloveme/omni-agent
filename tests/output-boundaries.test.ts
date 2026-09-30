import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionArtifactStore } from "../packages/app/src/persistence/session-artifact-store";
import { ToolInvocationRunner } from "../packages/core/src/execution/tool-invocation-runner";
import { createAuthorizedToolCall } from "../packages/core/src/execution/authorized-tool-call";
import { createToolResultMessage } from "../packages/core/src/session/factory";
import { toBackendMessages } from "../packages/models/src/runtime/message-mapper";
import { outputReadTool } from "../packages/tools/src/output/output-read";
import type { RegisteredAgentTool, ToolResult } from "../packages/core/src/types";
import type { SessionOutputPort } from "../packages/core/src/execution/output";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "omni-output-boundary-"));
  roots.push(root);
  return {
    root,
    store: new SessionArtifactStore(root, {
      previewBytes: 200,
      callBytes: 20000,
      sessionBytes: 40000,
    }),
  };
}
const runner = new ToolInvocationRunner({
  processRouter: {
    async run() {
      throw new Error("Unexpected process");
    },
  },
});
const wire = (result: ToolResult) =>
  JSON.stringify(
    toBackendMessages([createToolResultMessage("call", "test", result.content, result.isError)]),
  );

it.each([false, true])(
  "sanitizes middleware results with retention=%s before projection and persistence",
  async (enabled) => {
    const { root, store } = await setup();
    const tool: RegisteredAgentTool = {
      name: "test",
      originId: "test",
      toolIdentity: "test:test",
      description: "test",
      schema: {},
      access: { kind: "internal" },
      execution: { kind: "in_process" },
      timeout: { kind: "none" },
      async execute() {
        return {
          content: [{ type: "text", text: "SYNTHETIC_PRIVATE", outputSource: { kind: "page" } }],
          isError: false,
        };
      },
    };
    const run = async (outputs?: SessionOutputPort) => {
      const call = createAuthorizedToolCall(
        tool,
        {},
        { cwd: root, outputs },
        { mode: "unrestricted", sensitiveValues: { exactValues: ["SYNTHETIC_PRIVATE"] } },
      );
      const { result } = await runner.invoke(call, [
        {
          afterExecute(_ctx, result) {
            expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
            result.content.push({ type: "text", text: "SYNTHETIC_PRIVATE" + "x".repeat(1000) });
          },
        },
      ]);
      expect(wire(result)).not.toContain("SYNTHETIC_PRIVATE");
      expect(JSON.stringify(result.content)).not.toContain("outputSource");
      expect(wire(result)).toContain("[REDACTED]");
      if (outputs) {
        const record = result.meta!.output!;
        expect(
          (await outputs.read({ outputId: record.id, partId: record.parts[0]!.id })).text,
        ).not.toContain("SYNTHETIC_PRIVATE");
      }
    };
    if (enabled) await store.withSession("one", run);
    else await run();
  },
);

it.each([
  "prepend",
  "reorder",
  "clone",
  "replace",
  "remove",
  "storage-failure",
  "storage-finish-failure",
  "invalid-read",
])("preserves page boundaries and independent attachments after %s", async (mutation) => {
  const { root, store } = await setup();
  await store.withSession("one", async (session) => {
    const writer = await session.create("original");
    const part = await writer.createPart({ label: "body", mediaType: "text/plain" });
    await part.append("original page\n".repeat(100));
    const original = await writer.finish();
    const outputs: SessionOutputPort =
      mutation === "storage-finish-failure"
        ? {
            ...session,
            async create(id, signal) {
              const writer = await session.create(id, signal);
              return {
                ...writer,
                async finish() {
                  throw new Error("injected finish failure");
                },
              };
            },
          }
        : mutation === "storage-failure"
          ? {
              ...session,
              async create() {
                throw new Error("injected storage failure");
              },
            }
          : session;
    const call = createAuthorizedToolCall(
      { ...outputReadTool, originId: "test", toolIdentity: "test:read" },
      { outputId: original.id, partId: part.id },
      { cwd: root, outputs },
      { mode: "unrestricted" },
    );
    const attachment = "attachment-".repeat(100);
    const structured = { value: "json-".repeat(200) };
    let pageText = "";
    let statusText = "";
    let pagination: unknown;
    const { result } = await runner.invoke(call, [
      {
        afterExecute(_ctx, result) {
          pageText = result.content[0]!.text!;
          statusText = result.content[1]!.text!;
          pagination = structuredClone(result.meta!.pagination);
          if (mutation === "invalid-read")
            result.meta = {
              ...result.meta,
              outputRead: { outputId: original.id, partId: "missing" },
            };
          result.content = structuredClone(result.content);
          if (mutation === "clone") result.content.push(structuredClone(result.content[0]!));
          else if (mutation === "replace") result.content[0] = { type: "text", text: attachment };
          else if (mutation === "remove") result.content = [];
          if (mutation !== "replace") result.content.unshift({ type: "text", text: attachment });
          if (mutation === "reorder") result.content.reverse();
          result.structuredContent = structured;
        },
      },
    ]);
    if (mutation === "invalid-read") {
      expect(result.meta!.outputPersistence).toBe("failed");
      expect(result.meta!.outputRead).toBeUndefined();
      expect(result.content.some((p) => p.text === pageText)).toBe(false);
      expect(result.meta!.output).toBeUndefined();
      return;
    }
    if (mutation !== "replace" && mutation !== "remove")
      expect(result.content.some((p) => p.text === pageText)).toBe(true);
    if (mutation !== "remove") expect(result.content.some((p) => p.text === statusText)).toBe(true);
    expect(result.meta!.pagination).toEqual(pagination);
    expect(result.meta!.outputRead!.outputId).toBe(original.id);
    expect(result.meta!.outputRead!.partId).toBe(part.id);
    expect(JSON.stringify(result.content)).not.toContain("outputSource");
    expect(wire(result)).not.toContain("outputSource");
    expect((await session.read({ outputId: original.id, partId: part.id })).text).toContain(
      "original page",
    );
    if (mutation.startsWith("storage-")) {
      expect(result.meta!.outputPersistence).toBe("failed");
      expect(result.meta!.output).toBeUndefined();
      expect(Buffer.byteLength(result.content[0]!.text!)).toBeLessThanOrEqual(session.previewBytes);
      expect(result.structuredContent).toBeUndefined();
      return;
    }
    const saved = result.meta!.output!;
    expect(saved.id).not.toBe(original.id);
    expect(saved.parts).toHaveLength(2);
    const textPart = saved.parts.find((p) => p.mediaType === "text/plain")!;
    expect((await session.read({ outputId: saved.id, partId: textPart.id })).text).toBe(
      `1|${attachment}`,
    );
    expect(
      (
        await session.read({
          outputId: saved.id,
          partId: result.meta!.structuredOutputPart as string,
        })
      ).text,
    ).toBe(`1|${JSON.stringify(structured)}`);
    expect(result.structuredContent).toBeUndefined();
    expect(wire(result)).not.toContain(attachment);
  });
});

it("keeps redacted presentation separate from authoritative references across tool readback", async () => {
  const { root, store } = await setup();
  await store.withSession("one", async (outputs) => {
    const sensitiveValues = { exactValues: ["SYNTHETIC_PRIVATE"] };
    const tool: RegisteredAgentTool = {
      name: "capture",
      originId: "test",
      toolIdentity: "test:capture",
      description: "test",
      schema: {},
      access: { kind: "internal" },
      execution: { kind: "in_process" },
      timeout: { kind: "none" },
      async execute(_input, context) {
        const writer = await outputs.create(context.outputCall!.toolCallId);
        context.outputCall!.writer = writer;
        const part = await writer.createPart({
          label: "SYNTHETIC_PRIVATE",
          mediaType: "text/plain",
        });
        await part.append("safe captured body");
        return {
          content: [
            {
              type: "text",
              text: "safe preview",
              outputSource: { outputId: writer.id, partIds: [part.id] },
            },
          ],
          isError: false,
        };
      },
    };
    const { result } = await runner.invoke(
      createAuthorizedToolCall(
        tool,
        {},
        { cwd: root, outputs },
        { mode: "unrestricted", sensitiveValues },
      ),
      [],
      { toolCallId: "capture" },
    );
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
    const display = result.meta!.output!;
    expect(display.parts[0]!.label).toBe("[REDACTED]");
    const reference = { outputId: display.id, partId: display.parts[0]!.id };
    const authoritative = await outputs.resolve(reference);
    expect(authoritative.parts[0]!.label).toBe("SYNTHETIC_PRIVATE");
    expect(display.parts[0]!.label).toBe("[REDACTED]");
    const readCall = createAuthorizedToolCall(
      { ...outputReadTool, originId: "test", toolIdentity: "test:read" },
      reference,
      { cwd: root, outputs },
      { mode: "unrestricted", sensitiveValues },
    );
    const { result: page } = await runner.invoke(readCall, []);
    expect(page.isError).toBe(false);
    expect(page.meta!.outputPersistence).toBeUndefined();
    expect(page.meta!.outputRead).toEqual(reference);
    expect(wire(page)).toContain("safe captured body");
    expect(JSON.stringify(page)).not.toContain("SYNTHETIC_PRIVATE");
    expect(await outputs.resolve(reference)).toEqual(authoritative);
  });
});
