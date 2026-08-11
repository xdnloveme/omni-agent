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
) => ({
  agentId: "coding",
  toolIdentity: "builtin-coding:bash",
  toolName: "bash",
  mode,
  assessment: {
    risk,
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
      expect(policy.evaluate(context(risk))).toMatchObject({
        outcome: "ask",
        canAllowAlways: false,
      });
    }
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
});
