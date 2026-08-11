import { describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../permissions";
import type { PermissionControlledTool, ToolPermissionDescriptor } from "../permissions";

function tool(authorization: ToolPermissionDescriptor): PermissionControlledTool {
  return {
    name: "test_tool",
    originId: "test",
    toolIdentity: "test:test_tool",
    description: "test",
    schema: { type: "object" },
    authorization,
    execution: { kind: "host" },
    timeout: { kind: "none" },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
}

function context() {
  return {
    cwd: process.cwd(),
    agentId: "test",
    toolIdentity: "test:test_tool",
    toolCallId: "call-1",
  };
}

describe("PermissionGate", () => {
  it("creates an authorized call after user approval", async () => {
    const broker = { request: vi.fn(async () => "allow_once" as const) };
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "ask", reason: "execute", canAllowAlways: true }) },
      grants: grants(),
      broker,
    });
    const result = await gate.authorize({
      tool: tool({ kind: "static", risk: "execute", reason: "runs code" }),
      input: {},
      context: context(),
    });
    expect(result.outcome).toBe("allowed");
    expect(broker.request).toHaveBeenCalledOnce();
  });

  it("enforces hard deny before policy and broker", async () => {
    const policy = { evaluate: vi.fn(() => ({ outcome: "allow" as const, reason: "test" })) };
    const broker = { request: vi.fn(async () => "allow_once" as const) };
    const gate = new PermissionGate({ policy, grants: grants(), broker });
    const result = await gate.authorize({
      tool: tool({
        kind: "dynamic",
        assess: () => ({
          risk: "privileged",
          enforcement: "hard_deny",
          reasons: ["blocked"],
          ruleIds: ["test.hard"],
          presentation: { title: "blocked", reason: "blocked" },
        }),
      }),
      input: {},
      context: context(),
    });
    expect(result).toMatchObject({ outcome: "denied", source: "hard_stop" });
    expect(policy.evaluate).not.toHaveBeenCalled();
    expect(broker.request).not.toHaveBeenCalled();
  });

  it("isolates observer failures", async () => {
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "allow", reason: "read" }) },
      grants: grants(),
      broker: {
        async request() {
          return "deny";
        },
      },
      observer: {
        onResolved() {
          throw new Error("observer failed");
        },
      },
    });
    await expect(
      gate.authorize({
        tool: tool({ kind: "static", risk: "read", reason: "read" }),
        input: {},
        context: context(),
      }),
    ).resolves.toMatchObject({ outcome: "allowed" });
  });

  it("fails closed when a broker returns an invalid response", async () => {
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "ask", reason: "test", canAllowAlways: true }) },
      grants: grants(),
      broker: {
        async request() {
          return "invalid" as "allow_once";
        },
      },
    });

    await expect(
      gate.authorize({
        tool: tool({ kind: "static", risk: "execute", reason: "runs code" }),
        input: {},
        context: context(),
      }),
    ).resolves.toMatchObject({ outcome: "denied", source: "policy" });
  });

  it("rejects an invalid policy decision before approval", async () => {
    const broker = { request: vi.fn(async () => "allow_once" as const) };
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "invalid", reason: "test" }) as never },
      grants: grants(),
      broker,
    });

    await expect(
      gate.authorize({
        tool: tool({ kind: "static", risk: "execute", reason: "runs code" }),
        input: {},
        context: context(),
      }),
    ).rejects.toThrow("Permission policy outcome is invalid");
    expect(broker.request).not.toHaveBeenCalled();
  });

  it("uses a stored grant only for an eligible routine decision", async () => {
    const broker = { request: vi.fn(async () => "deny" as const) };
    const storedGrants = {
      ...grants(),
      async isToolAlwaysApproved() {
        return true;
      },
    };
    const routine = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "ask", reason: "test", canAllowAlways: true }) },
      grants: storedGrants,
      broker,
    });
    await expect(
      routine.authorize({
        tool: tool({ kind: "static", risk: "execute", reason: "runs code" }),
        input: {},
        context: context(),
      }),
    ).resolves.toMatchObject({ outcome: "allowed", source: "automatic_approval" });
    expect(broker.request).not.toHaveBeenCalled();

    const highRisk = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "ask", reason: "test", canAllowAlways: false }) },
      grants: storedGrants,
      broker,
    });
    await expect(
      highRisk.authorize({
        tool: tool({ kind: "static", risk: "execute", reason: "runs code" }),
        input: {},
        context: context(),
      }),
    ).resolves.toMatchObject({ outcome: "denied", source: "user" });
    expect(broker.request).toHaveBeenCalledOnce();
  });

  it("does not authorize when persistent approval cannot be saved", async () => {
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "ask", reason: "test", canAllowAlways: true }) },
      grants: {
        ...grants(),
        async approveTool() {
          throw new Error("write failed");
        },
      },
      broker: {
        async request() {
          return "allow_always";
        },
      },
    });

    await expect(
      gate.authorize({
        tool: tool({ kind: "static", risk: "execute", reason: "runs code" }),
        input: {},
        context: context(),
      }),
    ).rejects.toThrow("write failed");
  });

  it("isolates the authorized input from assessor mutation", async () => {
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "allow", reason: "test" }) },
      grants: grants(),
      broker: {
        async request() {
          return "deny";
        },
      },
    });
    const input = { nested: { value: "original" } };
    const result = await gate.authorize({
      tool: tool({
        kind: "dynamic",
        assess(candidate) {
          (candidate.nested as { value: string }).value = "mutated";
          return {
            risk: "read",
            enforcement: "policy",
            reasons: ["read"],
            ruleIds: [],
            presentation: { title: "read", reason: "read" },
          };
        },
      }),
      input,
      context: context(),
    });

    expect(result.outcome).toBe("allowed");
    if (result.outcome !== "allowed") throw new Error("expected authorization");
    expect(result.call.input).toEqual({ nested: { value: "original" } });
    expect(Object.isFrozen(result.call.input)).toBe(true);
    expect(Object.isFrozen(result.call.input.nested)).toBe(true);
  });
});

function grants() {
  return {
    async getMode() {
      return "standard" as const;
    },
    async isToolAlwaysApproved() {
      return false;
    },
    async approveTool() {},
  };
}
