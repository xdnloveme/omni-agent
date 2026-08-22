import { describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../permissions";
import type {
  ApprovalRequest,
  PermissionControlledTool,
  ToolPermissionDescriptor,
} from "../permissions";

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
          operationClass: "sensitive",
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
    const getGrantedScopeKeys = vi.fn(
      async (_agentId: string, _toolIdentity: string, candidates: readonly { key: string }[]) =>
        candidates.map(({ key }) => key),
    );
    const storedGrants = {
      ...grants(),
      getGrantedScopeKeys,
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
    expect(getGrantedScopeKeys).toHaveBeenCalledWith("test", "test:test_tool", [
      { key: "tool:routine", kind: "tool_routine" },
    ]);
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

  it("asks for and atomically saves only missing executable scopes", async () => {
    const keyA = `bash:executable:${"a".repeat(64)}`;
    const keyB = `bash:executable:${"b".repeat(64)}`;
    const requests: ApprovalRequest[] = [];
    const saveGrants = vi.fn(async () => undefined);
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "ask", reason: "unknown", canAllowAlways: true }) },
      grants: {
        ...grants(),
        getGrantedScopeKeys: vi.fn(async () => [keyA]),
        saveGrants,
      },
      broker: {
        async request(request) {
          requests.push(request);
          return "allow_always";
        },
      },
    });

    await gate.authorize({
      tool: tool({
        kind: "dynamic",
        assess: () =>
          executableAssessment([
            { key: keyA, label: "Always trust executable: a" },
            { key: keyB, label: "Always trust executable: b" },
          ]),
      }),
      input: {},
      context: context(),
    });

    expect(requests[0]?.persistentApprovals).toEqual([
      { kind: "bash_executable", label: "Always trust executable: b" },
    ]);
    expect(saveGrants).toHaveBeenCalledWith("test", [
      expect.objectContaining({ scopeKey: keyB, label: "Always trust executable: b" }),
    ]);
  });

  it("accepts any matching key for one persistent approval requirement", async () => {
    const directoryKey = `filesystem:read:directory:${"d".repeat(64)}`;
    const fileKey = `filesystem:read:file:${"f".repeat(64)}`;
    const broker = { request: vi.fn(async () => "deny" as const) };
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "ask", reason: "external", canAllowAlways: true }) },
      grants: {
        ...grants(),
        getGrantedScopeKeys: vi.fn(async () => [directoryKey]),
      },
      broker,
    });

    await expect(
      gate.authorize({
        tool: tool({
          kind: "dynamic",
          assess: () => ({
            risk: "external",
            operationClass: "sensitive",
            persistentApprovalRequirements: [
              {
                approval: {
                  key: fileKey,
                  kind: "filesystem_read_directory",
                  label: "Always allow reads under /tmp/reviews",
                },
                satisfiedBy: [
                  { key: fileKey, kind: "filesystem_read_directory" },
                  { key: directoryKey, kind: "filesystem_read_directory" },
                ],
              },
            ],
            enforcement: "policy",
            reasons: ["external"],
            ruleIds: ["path.outside-workspace.read"],
            presentation: { title: "Read file", reason: "external" },
          }),
        }),
        input: {},
        context: context(),
      }),
    ).resolves.toMatchObject({ outcome: "allowed", source: "automatic_approval" });
    expect(broker.request).not.toHaveBeenCalled();
  });

  it("does not authorize when persistent approval cannot be saved", async () => {
    const gate = new PermissionGate({
      policy: { evaluate: () => ({ outcome: "ask", reason: "test", canAllowAlways: true }) },
      grants: {
        ...grants(),
        async saveGrants() {
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
            operationClass: "routine",
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
    async getGrantedScopeKeys() {
      return [];
    },
    async saveGrants() {},
  };
}

function executableAssessment(scopes: readonly { key: string; label: string }[]) {
  return {
    risk: "unknown" as const,
    operationClass: "sensitive" as const,
    persistentApprovalRequirements: scopes.map(({ key, label }) => ({
      approval: { key, kind: "bash_executable" as const, label },
      satisfiedBy: [{ key, kind: "bash_executable" as const }],
    })),
    enforcement: "policy" as const,
    reasons: ["unknown"],
    ruleIds: ["shell.unknown"],
    presentation: { title: "Run", reason: "unknown" },
  };
}
