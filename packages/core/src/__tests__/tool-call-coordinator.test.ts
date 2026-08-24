import { describe, expect, it } from "vitest";
import { ToolAccessController } from "../access";
import { ToolInvocationRunner } from "../execution";
import { ToolCallCoordinator, ToolInputValidator } from "../tool-calls";
import type { RegisteredAgentTool } from "../types";

describe("ToolCallCoordinator process planning", () => {
  it("finalizes the process plan before lifecycle and executes it without re-planning", async () => {
    const order: string[] = [];
    const tool: RegisteredAgentTool = {
      name: "process_test",
      originId: "test",
      toolIdentity: "test:process_test",
      description: "test",
      schema: { type: "object", additionalProperties: false },
      timeout: { kind: "none" },
      access: { kind: "internal" },
      execution: { kind: "process" },
      createProcessInvocation() {
        throw new Error("the planner owns invocation creation");
      },
      createToolResult: () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    };
    const coordinator = new ToolCallCoordinator({
      inputValidator: new ToolInputValidator(),
      hostRuntime: { platform: "darwin", home: "/home/test" },
      accessController: new ToolAccessController({
        settings: {
          getSettings: async () => ({
            mode: "unrestricted",
            controlledNetworkEnabled: false,
            approvedFilesystemRoots: [],
          }),
          enableControlledNetwork: async () => undefined,
          addApprovedFilesystemRoots: async () => undefined,
        },
        consent: { request: async () => "deny" },
      }),
      processPlanner: {
        async prepare() {
          order.push("plan");
          return {
            route: "host",
            invocation: {
              command: "/usr/bin/true",
              args: [],
              cwd: "/workspace",
              maxOutputBytes: 1024,
            },
          };
        },
      },
      invocationRunner: new ToolInvocationRunner({
        processRouter: {
          async run(plan) {
            order.push("route:" + plan.route);
            return {
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              exitCode: 0,
              signal: null,
            };
          },
        },
      }),
    });

    for await (const _event of coordinator.run(
      [tool],
      { toolName: tool.name, toolCallId: "call", input: {} },
      {
        agentId: "coding",
        workspaceId: "workspace",
        workspaceRoot: "/workspace",
        cwd: "/workspace",
        middleware: [
          {
            beforeExecute: () => void order.push("middleware-start"),
            afterExecute: () => void order.push("middleware-end"),
          },
        ],
        lifecycleAdapters: [
          {
            supports: () => true,
            onStart: () => {
              order.push("lifecycle-start");
              return [];
            },
            onEnd: () => {
              order.push("lifecycle-end");
              return [];
            },
          },
        ],
      },
    )) {
      // Consume the coordinator event stream.
    }

    expect(order).toEqual([
      "plan",
      "lifecycle-start",
      "middleware-start",
      "route:host",
      "middleware-end",
      "lifecycle-end",
    ]);
  });
});
