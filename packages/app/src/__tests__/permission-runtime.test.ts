import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionControlledTool } from "@omni-agent/core";
import { DefaultPermissionPolicy } from "../permissions/default-permission-policy";
import { createPermissionRuntime } from "../permissions/create-permission-runtime";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

const context = (
  risk:
    | "read"
    | "write"
    | "execute"
    | "external_read"
    | "external"
    | "destructive"
    | "privileged"
    | "unknown",
  mode: "standard" | "supervised" = "standard",
  operationClass: "routine" | "sensitive" = "routine",
  persistentApprovalRequirements?: readonly {
    key: string;
    kind: "bash_executable";
    label: string;
  }[],
) => ({
  agentId: "coding",
  toolIdentity: "builtin-coding:bash",
  toolName: "bash",
  mode,
  assessment: {
    risk,
    operationClass,
    ...(persistentApprovalRequirements
      ? {
          persistentApprovalRequirements: persistentApprovalRequirements.map((approval) => ({
            approval,
            satisfiedBy: [{ key: approval.key, kind: approval.kind }],
          })),
        }
      : {}),
    enforcement: "policy" as const,
    reasons: [risk],
    ruleIds: [],
    presentation: { title: "test", reason: risk },
  },
});

describe("DefaultPermissionPolicy", () => {
  const policy = new DefaultPermissionPolicy();

  it("applies the standard and supervised write policy", () => {
    expect(policy.evaluate(context("write", "standard"))).toMatchObject({ outcome: "allow" });
    expect(policy.evaluate(context("write", "supervised"))).toMatchObject({
      outcome: "ask",
      canAllowAlways: true,
    });
  });

  it("asks every time for high-risk operations", () => {
    for (const risk of ["external", "destructive", "privileged", "unknown"] as const) {
      expect(policy.evaluate(context(risk, "standard", "sensitive"))).toMatchObject({
        outcome: "ask",
        canAllowAlways: false,
      });
    }
  });

  it("allows persistent approval for routine external operations", () => {
    expect(policy.evaluate(context("external", "standard", "routine"))).toMatchObject({
      outcome: "ask",
      canAllowAlways: true,
    });
  });

  it("allows external reads only in standard mode", () => {
    expect(policy.evaluate(context("external_read", "standard"))).toMatchObject({
      outcome: "allow",
    });
    expect(policy.evaluate(context("external_read", "supervised"))).toMatchObject({
      outcome: "ask",
      canAllowAlways: true,
    });
  });

  it("allows an unknown executable to propose its explicit scope", () => {
    expect(
      policy.evaluate(
        context("unknown", "standard", "sensitive", [
          {
            key: "bash:executable:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            kind: "bash_executable",
            label: "Always trust executable: mycli",
          },
        ]),
      ),
    ).toMatchObject({ outcome: "ask", canAllowAlways: true });
  });

  it("allows an executable scope without interpreting a sensitive CLI subcommand", () => {
    expect(
      policy.evaluate(
        context("external", "standard", "sensitive", [
          {
            key: "bash:executable:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            kind: "bash_executable",
            label: "Always trust executable: npm",
          },
        ]),
      ),
    ).toMatchObject({ outcome: "ask", canAllowAlways: true });
  });

  it("does not persist sensitive execute decisions", () => {
    expect(policy.evaluate(context("execute", "standard", "sensitive"))).toMatchObject({
      outcome: "ask",
      canAllowAlways: false,
    });
  });
});

describe("permission runtime composition", () => {
  it("wires the observer into the permission gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-permission-runtime-"));
    directories.push(root);
    const observer = { onResolved: vi.fn() };
    const runtime = createPermissionRuntime({ globalDirectory: root, observer });
    const tool: PermissionControlledTool = {
      name: "read_test",
      description: "read",
      schema: { type: "object", additionalProperties: false },
      authorization: { kind: "static", risk: "read", reason: "read" },
      execution: { kind: "host" },
      timeout: { kind: "none" },
      originId: "test",
      toolIdentity: "test:read_test",
      async execute() {
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    };

    await runtime.permissionGate.authorize({
      tool,
      input: {},
      context: {
        agentId: "test",
        cwd: root,
        toolCallId: "call-1",
        toolIdentity: tool.toolIdentity,
      },
    });

    expect(observer.onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ toolIdentity: tool.toolIdentity, source: "policy" }),
    );
  });

  it("applies a stored tool grant only to routine assessments", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-permission-runtime-"));
    directories.push(root);
    const requestApproval = vi.fn(async () => "deny" as const);
    const runtime = createPermissionRuntime({
      globalDirectory: root,
      approvalBroker: { request: requestApproval },
    });
    const tool: PermissionControlledTool = {
      name: "bash",
      description: "shell",
      schema: { type: "object", additionalProperties: false },
      authorization: {
        kind: "dynamic",
        assess(input) {
          const operationClass = input.sensitive ? "sensitive" : "routine";
          return {
            risk: "external",
            operationClass,
            enforcement: "policy",
            reasons: [operationClass],
            ruleIds: [],
            presentation: { title: "bash", reason: operationClass },
          };
        },
      },
      execution: { kind: "host" },
      timeout: { kind: "none" },
      originId: "builtin-coding",
      toolIdentity: "builtin-coding:bash",
      async execute() {
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    };
    const request = (input: Record<string, unknown>) => ({
      tool,
      input,
      context: {
        agentId: "coding",
        cwd: root,
        toolCallId: "call-1",
        toolIdentity: tool.toolIdentity,
      },
    });

    await runtime.service.saveGrants("coding", [
      {
        toolIdentity: tool.toolIdentity,
        toolName: tool.name,
        scopeKey: "tool:routine",
        scopeKind: "tool_routine",
        label: "Always approve routine bash operations",
      },
    ]);

    await expect(runtime.permissionGate.authorize(request({}))).resolves.toMatchObject({
      outcome: "allowed",
      source: "automatic_approval",
    });
    expect(requestApproval).not.toHaveBeenCalled();

    await expect(
      runtime.permissionGate.authorize(request({ sensitive: true })),
    ).resolves.toMatchObject({ outcome: "denied", source: "user" });
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it("persists missing executable scopes and automatically approves the next call", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-permission-runtime-"));
    directories.push(root);
    const requestApproval = vi.fn(async () => "allow_always" as const);
    const runtime = createPermissionRuntime({
      globalDirectory: root,
      approvalBroker: { request: requestApproval },
    });
    const scopes = [
      {
        key: `bash:executable:${"a".repeat(64)}`,
        kind: "bash_executable" as const,
        label: "Always trust executable: a",
      },
      {
        key: `bash:executable:${"b".repeat(64)}`,
        kind: "bash_executable" as const,
        label: "Always trust executable: b",
      },
    ];
    const tool: PermissionControlledTool = {
      name: "bash",
      description: "shell",
      schema: { type: "object", additionalProperties: false },
      authorization: {
        kind: "dynamic",
        assess: () => ({
          risk: "unknown",
          operationClass: "sensitive",
          persistentApprovalRequirements: scopes.map((approval) => ({
            approval,
            satisfiedBy: [
              { key: approval.key, kind: approval.kind },
              { key: "tool:routine", kind: "tool_routine" as const },
            ],
          })),
          enforcement: "policy",
          reasons: ["unknown"],
          ruleIds: ["shell.unknown"],
          presentation: { title: "bash", reason: "unknown" },
        }),
      },
      execution: { kind: "host" },
      timeout: { kind: "none" },
      originId: "builtin-coding",
      toolIdentity: "builtin-coding:bash",
      async execute() {
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    };
    const request = {
      tool,
      input: {},
      context: {
        agentId: "coding",
        cwd: root,
        toolCallId: "call-1",
        toolIdentity: tool.toolIdentity,
      },
    };

    await expect(runtime.permissionGate.authorize(request)).resolves.toMatchObject({
      outcome: "allowed",
      source: "user",
    });
    expect(await runtime.service.listPersistentApprovals("coding")).toHaveLength(2);
    await expect(runtime.permissionGate.authorize(request)).resolves.toMatchObject({
      outcome: "allowed",
      source: "automatic_approval",
    });
    expect(requestApproval).toHaveBeenCalledOnce();
  });
});
