import { mkdir, mkdtemp, writeFile, unlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PreparedToolBatch } from "@omni-agent/core";
import { InstructionScopeGate } from "../instructions";
import { bashTool } from "@omni-agent/tools";

describe("InstructionScopeGate", () => {
  it("loads exact Bash target rules even when a workspace subtree already covers access", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omni-scope-coverage-")));
    try {
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "nested", "AGENTS.md"), "Do not edit generated files.");
      if (bashTool.access.kind !== "dynamic") throw new Error("Expected dynamic Bash access");
      const intent = await bashTool.access.assess(
        {
          command: "printf x > nested/output.txt",
          sandbox_scope: { write_paths: [{ path: root, scope: "subtree" }] },
        },
        {
          cwd: root,
          workspaceRoot: root,
          workspaceId: "review",
          agentId: "coding",
          toolCallId: "call",
          hostRuntime: { platform: "darwin", home: "/Users/test" },
        },
      );
      const gate = await InstructionScopeGate.create(root);
      await gate.contributor(root);
      const batch = {
        calls: [{ preparation: "ready", accessIntent: intent }],
      } as unknown as PreparedToolBatch;
      const decision = await gate.evaluate(batch, { origin: "agent" });
      expect(decision.kind).toBe("deferred");
      if (decision.kind !== "deferred") throw new Error("Expected scoped rules");
      expect(decision.promptSections?.[0]?.content).toContain("Do not edit generated files.");
      await expect(gate.evaluate(batch, { origin: "agent" })).resolves.toEqual({
        kind: "executable",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("activates more than sixteen small manifests while keeping digest reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-instructions-many-"));
    const paths: string[] = [];
    const gate = await InstructionScopeGate.create(root);
    await gate.contributor(root);
    for (let i = 0; i < 17; i++) {
      const dir = join(root, `scope-${i}`);
      await mkdir(dir);
      await writeFile(join(dir, "AGENTS.md"), `rule ${i}`);
      paths.push(join(dir, "file.ts"));
      await expect(
        gate.evaluate(preparedBatch([paths.at(-1)!]), { origin: "agent" }),
      ).resolves.toMatchObject({ kind: "deferred" });
    }
    await expect(gate.evaluate(preparedBatch(paths), { origin: "agent" })).resolves.toEqual({
      kind: "executable",
    });
  });
  it("loads sibling scopes together and defers once per new digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-instructions-"));
    const left = join(root, "left");
    const right = join(root, "right");
    await Promise.all([mkdir(left), mkdir(right)]);
    await writeFile(join(root, "AGENTS.md"), "root rule");
    await writeFile(join(left, "AGENTS.md"), "left rule");
    await writeFile(join(right, "AGENTS.md"), "right rule");
    const gate = await InstructionScopeGate.create(root);
    await gate.contributor(root);

    const batch = preparedBatch([join(left, "file.ts"), join(right, "file.ts")]);
    const hook = await gate.evaluate(batch, { origin: "hook" });
    expect(hook).toMatchObject({ kind: "failed", code: "project_instructions_not_activated" });
    const first = await gate.evaluate(batch, { origin: "agent" });
    expect(first).toMatchObject({ kind: "deferred", code: "project_instructions_loaded" });
    if (first.kind !== "deferred") throw new Error("expected deferred decision");
    expect(first.promptSections?.[0]?.content).toContain("left rule");
    expect(first.promptSections?.[0]?.content).toContain("right rule");
    await expect(gate.evaluate(batch, { origin: "agent" })).resolves.toEqual({
      kind: "executable",
    });

    await writeFile(join(left, "AGENTS.md"), "left rule");
    await expect(gate.evaluate(batch, { origin: "agent" })).resolves.toEqual({
      kind: "executable",
    });
    await writeFile(join(left, "AGENTS.md"), "changed left rule");
    await expect(gate.evaluate(batch, { origin: "agent" })).resolves.toMatchObject({
      kind: "deferred",
    });

    gate.onContextCheckpoint("checkpoint-1");
    await expect(gate.evaluate(batch, { origin: "agent" })).resolves.toMatchObject({
      kind: "deferred",
    });
    gate.onContextCheckpoint("checkpoint-1");
    await expect(gate.evaluate(batch, { origin: "agent" })).resolves.toEqual({
      kind: "executable",
    });
    const refreshedBase = await gate.contributor(root);
    expect(refreshedBase).toContain("root rule");
    expect(refreshedBase).not.toContain("left rule");
  });

  it("does not scan external approved roots and rejects unbounded mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-instructions-"));
    const external = await mkdtemp(join(tmpdir(), "omni-external-"));
    await writeFile(join(external, "AGENTS.md"), "must not load");
    const gate = await InstructionScopeGate.create(root);
    await gate.contributor(root);
    await expect(
      gate.evaluate(preparedBatch([external], "external"), { origin: "agent" }),
    ).resolves.toEqual({
      kind: "executable",
    });
    await expect(gate.evaluate(unboundedBatch(), { origin: "agent" })).resolves.toMatchObject({
      kind: "failed",
      code: "project_instruction_scope_undetermined",
    });
  });

  it("resets target manifests at each Run boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-instructions-runs-"));
    const left = join(root, "left");
    const right = join(root, "right");
    await Promise.all([mkdir(left), mkdir(right)]);
    await writeFile(join(root, "AGENTS.md"), "root rule");
    await writeFile(join(left, "AGENTS.md"), "left rule");
    await writeFile(join(right, "AGENTS.md"), "right rule");
    const gate = await InstructionScopeGate.create(root);
    await gate.contributor(root);

    gate.beginRun();
    const leftDecision = await gate.evaluate(preparedBatch([join(left, "file.ts")]), {
      origin: "agent",
    });
    expect(leftDecision).toMatchObject({ kind: "deferred" });
    gate.beginRun();
    const rightDecision = await gate.evaluate(preparedBatch([join(right, "file.ts")]), {
      origin: "agent",
    });
    expect(rightDecision).toMatchObject({ kind: "deferred" });
    if (rightDecision.kind !== "deferred") throw new Error("expected deferred decision");
    expect(rightDecision.promptSections?.[0]?.content).toContain("root rule");
    expect(rightDecision.promptSections?.[0]?.content).toContain("right rule");
    expect(rightDecision.promptSections?.[0]?.content).not.toContain("left rule");
  });

  it("explicitly revokes a removed rule even when no active rules remain", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-instructions-delete-"));
    const file = join(root, "AGENTS.md");
    await writeFile(file, "old rule");
    const gate = await InstructionScopeGate.create(root);
    await gate.contributor(root);
    await unlink(file);
    const decision = await gate.evaluate(preparedBatch([root]), { origin: "agent" });
    expect(decision).toMatchObject({ kind: "deferred" });
    if (decision.kind !== "deferred") throw new Error("expected deferred decision");
    expect(decision.message).toContain("removed sources no longer apply");
    expect(decision.promptSections?.[0]?.content).toContain("No active AGENTS.md instructions");
  });
});

function preparedBatch(
  paths: readonly string[],
  location: "workspace" | "external" = "workspace",
): PreparedToolBatch {
  return {
    calls: [
      {
        toolName: "file_write",
        toolCallId: "call",
        input: {},
        preparation: "ready",
        accessIntent: {
          resources: paths.map((path) => ({
            kind: "filesystem" as const,
            access: "write" as const,
            path,
            scope: "exact" as const,
            location,
            sensitivity: "ordinary" as const,
          })),
          filesystemMutation: "bounded",
        },
      },
    ],
  } as unknown as PreparedToolBatch;
}

function unboundedBatch(): PreparedToolBatch {
  return {
    calls: [
      {
        toolName: "bash",
        toolCallId: "call",
        input: {},
        preparation: "ready",
        accessIntent: { resources: [{ kind: "process" }], filesystemMutation: "unbounded" },
      },
    ],
  } as unknown as PreparedToolBatch;
}
