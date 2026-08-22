import { describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../permissions";
import { ToolAuthorizationRouter, ToolCallCoordinator, ToolInputValidator } from "../tool-calls";
import { ToolInvocationRunner } from "../execution";
import {
  NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
  type RuntimeToolCallStartedFact,
} from "../runtime-observation";
import { RecordingRuntimeObserver } from "../testing/runtime-observation";
import type { RegisteredAgentTool, ToolResult } from "../types";

function fixture(options: { allow?: boolean } = {}) {
  const order: string[] = [];
  const evaluate = vi.fn(() =>
    options.allow === false
      ? { outcome: "deny" as const, reason: "denied" }
      : { outcome: "allow" as const, reason: "allowed" },
  );
  const getMode = vi.fn(async () => "standard" as const);
  const execute = vi.fn(async (_input: Record<string, unknown>, context: { cwd: string }) => {
    order.push(`execute:${context.cwd}`);
    return { content: [{ type: "text" as const, text: "ok" }], isError: false };
  });
  const tool: RegisteredAgentTool = {
    name: "echo",
    originId: "test",
    toolIdentity: "test:echo",
    description: "echo",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } },
    },
    authorization: { kind: "static", risk: "read", reason: "read" },
    execution: { kind: "host" },
    timeout: { kind: "none" },
    execute,
  };
  const gate = new PermissionGate({
    policy: {
      evaluate,
    },
    grants: {
      getMode,
      async getGrantedScopeKeys() {
        return [];
      },
      async saveGrants() {},
    },
    broker: {
      async request() {
        return "deny";
      },
    },
  });
  const inputValidator = new ToolInputValidator();
  const authorizer = new ToolAuthorizationRouter(gate, inputValidator);
  return {
    order,
    execute,
    evaluate,
    getMode,
    tool,
    gate,
    authorizer,
    coordinator: new ToolCallCoordinator({
      authorizer,
      invocationRunner: new ToolInvocationRunner(),
      inputValidator,
    }),
  };
}

async function events(
  fixtureValue: ReturnType<typeof fixture>,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const result = [];
  for await (const event of fixtureValue.coordinator.run(
    [fixtureValue.tool],
    { toolName: "echo", toolCallId: "call-1", input, signal },
    {
      agentId: "test",
      cwd: "/workspace",
      lifecycleAdapters: [],
      middleware: [
        {
          beforeExecute() {
            fixtureValue.order.push("before");
          },
          afterExecute() {
            fixtureValue.order.push("after");
          },
        },
      ],
    },
  )) {
    result.push(event);
  }
  return result;
}

describe("ToolCallCoordinator", () => {
  it("validates before authorization and execution", async () => {
    const value = fixture();
    const result = await events(value, {});
    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: { isError: true },
      durationMs: 0,
    });
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.order).toEqual([]);
  });

  it("validates and executes the input produced by dynamic authorization binding", async () => {
    const value = fixture();
    const assess = vi.fn(() => ({
      risk: "read" as const,
      operationClass: "routine" as const,
      enforcement: "policy" as const,
      reasons: ["read"],
      ruleIds: [],
      presentation: { title: "Read", reason: "read" },
    }));
    value.tool.authorization = {
      kind: "dynamic",
      bindInput: (input) => ({ ...input, value: String(input.value).toUpperCase() }),
      assess,
    };
    const input = { value: "bound" };

    const result = await events(value, input);

    expect(result.at(-1)).toMatchObject({ result: { isError: false } });
    expect(assess).toHaveBeenCalledWith(
      { value: "BOUND" },
      expect.objectContaining({ toolCallId: "call-1" }),
    );
    expect(value.execute).toHaveBeenCalledWith(
      { value: "BOUND" },
      expect.objectContaining({ cwd: "/workspace" }),
    );
    expect(input).toEqual({ value: "bound" });
  });

  it("rejects bound input that no longer matches the tool schema", async () => {
    const value = fixture();
    const assess = vi.fn();
    value.tool.authorization = {
      kind: "dynamic",
      bindInput: (input) => ({ ...input, value: 42 }),
      assess,
    };

    const result = await events(value, { value: "valid-before-binding" });

    expect(result.at(-1)).toMatchObject({
      result: { isError: true, meta: { code: "tool_authorization_failed" } },
    });
    expect(assess).not.toHaveBeenCalled();
    expect(value.execute).not.toHaveBeenCalled();
  });

  it("carries descriptor-hidden input keys into Tool Replay", async () => {
    const value = fixture();
    const recorded: RuntimeToolCallStartedFact[] = [];
    value.tool.authorization = {
      kind: "static",
      risk: "read",
      reason: "read",
      hiddenInputKeys: ["value"],
    };
    const observation = {
      ...NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
      startCall(fact: RuntimeToolCallStartedFact) {
        recorded.push(fact);
        return NOOP_RUNTIME_TOOL_BATCH_OBSERVATION.startCall(fact);
      },
    };

    const result = [];
    for await (const event of value.coordinator.run(
      [value.tool],
      { toolName: "echo", toolCallId: "call-1", input: { value: "private" } },
      {
        agentId: "test",
        cwd: "/workspace",
        lifecycleAdapters: [],
        middleware: [],
      },
      observation,
    )) {
      result.push(event);
    }

    expect(recorded).toContainEqual(
      expect.objectContaining({
        hiddenInputKeys: ["value"],
        input: { value: "private" },
      }),
    );
    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: { isError: false },
    });
  });

  it("closes Tool Call observation before publishing the terminal event", async () => {
    const value = fixture();
    const recorder = new RecordingRuntimeObserver();
    const run = recorder.startRun({ agentId: "test", sessionId: "session", runId: "run" });
    const turn = run.startTurn({ turn: 0 });
    const batch = turn.startToolBatch({
      batch: {
        batchId: "batch",
        modelCallId: "model-call",
        members: [{ toolName: "echo", toolCallId: "call-1", preview: { action: "execute" } }],
      },
    });
    const iterator = value.coordinator.run(
      [value.tool],
      { toolName: "echo", toolCallId: "call-1", input: { value: "hello" } },
      {
        agentId: "test",
        batchId: "batch",
        cwd: "/workspace",
        lifecycleAdapters: [],
        middleware: [],
      },
      batch,
    );

    await iterator.next();
    const terminal = await iterator.next();

    expect(terminal.value).toMatchObject({ type: "tool_end", toolCallId: "call-1" });
    expect(recorder.records.map((record) => record.operation)).toContain("tool.call.completed");
  });

  it("stops on domain preflight errors before authorization and execution", async () => {
    const value = fixture();
    const preflight = vi.fn(async () => ({
      outcome: "error" as const,
      result: {
        content: [{ type: "text" as const, text: "Target does not exist" }],
        isError: true,
        meta: { code: "path_not_found" },
      },
    }));
    value.tool.preflight = { validate: preflight };

    const result = await events(value, { value: "ok" });

    expect(preflight).toHaveBeenCalledWith(
      { value: "ok" },
      expect.objectContaining({ cwd: "/workspace" }),
    );
    expect(value.evaluate).not.toHaveBeenCalled();
    expect(value.getMode).not.toHaveBeenCalled();
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.order).toEqual([]);
    expect(result.at(-1)).toMatchObject({
      result: { meta: { code: "path_not_found" } },
      metrics: { authorizationMs: 0, executionMs: 0 },
    });
  });

  it("runs middleware only around an authorized invocation with the configured cwd", async () => {
    const value = fixture();
    const result = await events(value, { value: "ok" });
    expect(value.order).toEqual(["before", "execute:/workspace", "after"]);
    expect(result.at(-1)).toMatchObject({ type: "tool_end", result: { isError: false } });
  });

  it("turns non-JSON tool metadata into a structured tool error", async () => {
    const value = fixture();
    value.tool.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
      meta: { unsupported: 1n },
    }));

    const result = await events(value, { value: "ok" });

    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("must be a JSON object") }],
      },
    });
  });

  it("keeps presentation metadata transient while preserving transcript details", async () => {
    const value = fixture();
    value.tool.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
      meta: {
        presentation: { resource: { kind: "file" as const, path: "/workspace/a.ts" } },
        pagination: { startLine: 1, endLine: 10 },
      },
    }));

    const result = await events(value, { value: "ok" });
    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: {
        meta: { presentation: { resource: { path: "/workspace/a.ts" } } },
        transcriptDetails: { pagination: { startLine: 1, endLine: 10 } },
      },
    });
  });

  it("does not run middleware or tool after denial", async () => {
    const value = fixture({ allow: false });
    const result = await events(value, { value: "ok" });
    expect(value.order).toEqual([]);
    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: { meta: { code: "permission_denied" } },
      durationMs: 0,
    });
  });

  it("does not expose permission evaluator errors", async () => {
    const value = fixture();
    value.tool.authorization = {
      kind: "dynamic",
      assess() {
        throw new Error("secret file body");
      },
    };

    const result = await events(value, { value: "ok" });
    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: {
        isError: true,
        meta: { code: "tool_authorization_failed" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret file body");
    expect(value.execute).not.toHaveBeenCalled();
  });

  it("authorizes trusted tools without consulting permission policy or storage", async () => {
    const value = fixture();
    value.tool.authorization = { kind: "trusted", reason: "internal operation" };

    const result = await events(value, { value: "ok" });

    expect(value.evaluate).not.toHaveBeenCalled();
    expect(value.getMode).not.toHaveBeenCalled();
    expect(value.execute).toHaveBeenCalledOnce();
    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: { isError: false },
      metrics: { authorizationMs: expect.any(Number) },
    });
  });

  it("aborts promptly when a tool does not cooperate with its signal", async () => {
    const value = fixture();
    const execute = vi.fn(() => new Promise<ToolResult>(() => undefined));
    value.tool.execute = execute;
    const controller = new AbortController();
    const pending = events(value, { value: "ok" }, controller.signal);
    while (execute.mock.calls.length === 0) await new Promise(setImmediate);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns a structured timeout without running afterExecute", async () => {
    const value = fixture();
    value.tool.timeout = { kind: "fixed", timeoutMs: 5 };
    value.tool.execute = vi.fn(
      async () =>
        await new Promise<ToolResult>((resolve) =>
          setTimeout(
            () => resolve({ content: [{ type: "text", text: "late" }], isError: false }),
            30,
          ),
        ),
    );
    value.coordinator = new ToolCallCoordinator({
      authorizer: value.authorizer,
      invocationRunner: new ToolInvocationRunner({ cleanupGraceMs: 1 }),
      inputValidator: new ToolInputValidator(),
    });

    const result = await events(value, { value: "ok" });

    expect(value.order).toEqual(["before"]);
    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: {
        isError: true,
        meta: { code: "tool_timeout", timeoutMs: 5, retryable: true },
      },
    });
  });

  it("observes late settlement without changing the timeout result", async () => {
    const value = fixture();
    const onLateSettlement = vi.fn();
    value.tool.timeout = { kind: "fixed", timeoutMs: 5 };
    value.tool.execute = vi.fn(
      async () =>
        await new Promise<ToolResult>((resolve) =>
          setTimeout(
            () => resolve({ content: [{ type: "text", text: "late" }], isError: false }),
            30,
          ),
        ),
    );
    value.coordinator = new ToolCallCoordinator({
      authorizer: value.authorizer,
      invocationRunner: new ToolInvocationRunner({ cleanupGraceMs: 1, onLateSettlement }),
      inputValidator: new ToolInputValidator(),
    });

    const result = await events(value, { value: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(result.at(-1)).toMatchObject({ result: { meta: { code: "tool_timeout" } } });
    expect(onLateSettlement).toHaveBeenCalledWith({
      toolName: "echo",
      outcome: "fulfilled",
    });
    expect(value.order).toEqual(["before"]);
  });

  it("routes authorized execution through the configured sandbox port", async () => {
    const value = fixture();
    const sandboxRunner = {
      run: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "sandboxed" }],
        isError: false,
      })),
    };
    value.coordinator = new ToolCallCoordinator({
      authorizer: value.authorizer,
      invocationRunner: new ToolInvocationRunner({ sandboxRunner }),
      inputValidator: new ToolInputValidator(),
    });
    value.tool.execution = { kind: "sandbox_eligible", profile: "test" };

    const result = await events(value, { value: "ok" });
    expect(sandboxRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: value.tool,
        input: { value: "ok" },
        context: expect.objectContaining({ cwd: "/workspace" }),
        profile: "test",
      }),
    );
    expect(value.execute).not.toHaveBeenCalled();
    expect(result.at(-1)).toMatchObject({
      type: "tool_end",
      result: { content: [{ text: "sandboxed" }] },
    });
  });

  it("keeps host tools out of a configured sandbox port", async () => {
    const value = fixture();
    const sandboxRunner = { run: vi.fn() };
    value.coordinator = new ToolCallCoordinator({
      authorizer: value.authorizer,
      invocationRunner: new ToolInvocationRunner({ sandboxRunner }),
      inputValidator: new ToolInputValidator(),
    });

    await events(value, { value: "ok" });

    expect(sandboxRunner.run).not.toHaveBeenCalled();
    expect(value.execute).toHaveBeenCalledOnce();
  });

  it("runs a sandbox-eligible tool on the host when no sandbox backend is configured", async () => {
    const value = fixture();
    value.tool.execution = { kind: "sandbox_eligible", profile: "test" };

    await events(value, { value: "ok" });

    expect(value.execute).toHaveBeenCalledOnce();
  });

  it("isolates execution input from lifecycle adapter mutation", async () => {
    const value = fixture();
    const received: Record<string, unknown>[] = [];
    value.tool.execute = vi.fn(async (input) => {
      received.push(input);
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    });
    const result = [];
    for await (const event of value.coordinator.run(
      [value.tool],
      { toolName: "echo", toolCallId: "call-1", input: { value: "original" } },
      {
        agentId: "test",
        cwd: "/workspace",
        middleware: [],
        lifecycleAdapters: [
          {
            supports: () => true,
            onStart(input) {
              input.input.value = "mutated";
              return [];
            },
            onEnd: () => [],
          },
        ],
      },
    )) {
      result.push(event);
    }

    expect(received).toEqual([{ value: "original" }]);
    expect(result.at(-1)).toMatchObject({ type: "tool_end", result: { isError: false } });
  });
});
