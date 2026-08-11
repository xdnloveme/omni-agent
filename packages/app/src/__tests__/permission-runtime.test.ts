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
) => ({
  agentId: "coding",
  toolIdentity: "builtin-coding:bash",
  toolName: "bash",
  mode,
  assessment: {
    risk,
    operationClass,
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
      canAllowAlways: false,
    });
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

    await runtime.service.approveTool("coding", tool.toolIdentity, tool.name);

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
});
