import { describe, expect, it } from "vitest";
import { ToolAccessController } from "../access";
import { ToolInvocationRunner } from "../execution";
import { ToolCallCoordinator, ToolInputValidator } from "../tool-calls";
import type { RegisteredAgentTool } from "../types";

describe("ToolCallCoordinator process planning", () => {
  it("revalidates after consent and stops before planning, lifecycle, or execution", async () => {
    const order: string[] = [];
    const approvedNetworkTargets: import("../network").NetworkTarget[] = [];
    const tool: RegisteredAgentTool = {
      name: "network_test",
      originId: "test",
      toolIdentity: "test:network_test",
      description: "test",
      schema: { type: "object" },
      timeout: { kind: "none" },
      execution: { kind: "in_process" },
      access: {
        kind: "dynamic",
        assess: () => {
          order.push("assess");
          return {
            resources: [
              {
                kind: "network",
                target: { scheme: "https", host: "example.com", port: 443 },
                purpose: "test",
              },
            ],
          };
        },
      },
      execute: async () => {
        throw new Error("must not execute");
      },
    };
    const coordinator = new ToolCallCoordinator({
      inputValidator: new ToolInputValidator(),
      hostRuntime: { platform: "darwin", home: "/home/test" },
      accessController: new ToolAccessController({
        settings: {
          getSettings: async () => ({
            mode: "controlled",
            approvedNetworkTargets,
            approvedFilesystemRoots: [],
          }),
          addApprovedAccess: async (_workspace, _agent, { targets }) => {
            approvedNetworkTargets.push(...targets);
          },
        },
        consent: {
          request: async () => {
            order.push("consent");
            return "approve";
          },
        },
      }),
      processPlanner: {
        prepare: async () => {
          throw new Error("must not plan");
        },
      },
      invocationRunner: new ToolInvocationRunner({
        processRouter: {
          run: async () => {
            throw new Error("must not run");
          },
        },
      }),
    });
    const environment = {
      agentId: "coding",
      workspaceId: "workspace",
      workspaceRoot: "/workspace",
      cwd: "/workspace",
      middleware: [
        {
          beforeExecute: () => {
            throw new Error("must not enter middleware");
          },
        },
      ],
      lifecycleAdapters: [],
    };
    const batch = await coordinator.prepareBatch({
      tools: [tool],
      calls: [{ toolName: tool.name, toolCallId: "call", input: {} }],
      environment,
    });
    const events = [];
    for await (const event of coordinator.authorizeAndRun(batch.calls[0]!, {
      environment,
      revalidate: async () => {
        order.push("revalidate");
        return {
          content: [{ type: "text", text: "Rules changed during consent" }],
          isError: false,
          meta: { code: "project_instructions_loaded", executed: false, retryable: true },
        };
      },
    }))
      events.push(event);
    expect(order).toEqual(["assess", "consent", "revalidate"]);
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({
      result: { meta: { code: "project_instructions_loaded" } },
      metrics: { executed: false },
    });
  });
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
            approvedNetworkTargets: [],
            approvedFilesystemRoots: [],
          }),
          addApprovedAccess: async () => undefined,
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

    const environment = {
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
    };
    const batch = await coordinator.prepareBatch({
      tools: [tool],
      calls: [{ toolName: tool.name, toolCallId: "call", input: {} }],
      environment,
    });
    for await (const _event of coordinator.authorizeAndRun(batch.calls[0]!, { environment })) {
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
