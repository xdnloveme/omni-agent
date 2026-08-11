import { describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../permissions";
import { ToolAuthorizationRouter, ToolCallCoordinator, ToolInputValidator } from "../tool-calls";
import { ToolInvocationRunner } from "../execution";
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
    execute,
  };
  const gate = new PermissionGate({
    policy: {
      evaluate,
    },
    grants: {
      getMode,
      async isToolAlwaysApproved() {
        return false;
      },
      async approveTool() {},
    },
    broker: {
      async request() {
        return "deny";
      },
    },
  });
  const authorizer = new ToolAuthorizationRouter(gate);
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
      inputValidator: new ToolInputValidator(),
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

  it("runs middleware only around an authorized invocation with the configured cwd", async () => {
    const value = fixture();
    const result = await events(value, { value: "ok" });
    expect(value.order).toEqual(["before", "execute:/workspace", "after"]);
    expect(result.at(-1)).toMatchObject({ type: "tool_end", result: { isError: false } });
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
