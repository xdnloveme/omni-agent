import { describe, expect, it } from "vitest";
import {
  EnvironmentContextController,
  EnvironmentContextError,
  renderEnvironmentContext,
} from "../environment";
import type { RuntimeEnvironmentSnapshot } from "../environment";

function snapshot(
  overrides: Partial<RuntimeEnvironmentSnapshot["time"]> = {},
): RuntimeEnvironmentSnapshot {
  return {
    workspace: { cwd: "/workspace/project", roots: ["/workspace"] },
    time: { currentDate: "2026-08-17", timezone: "Asia/Shanghai", ...overrides },
    execution: { platform: "linux", arch: "x64", shell: "/bin/zsh", kind: "host" },
  };
}

describe("EnvironmentContextController", () => {
  it("emits once for identical snapshots and emits a complete replacement after a change", async () => {
    let current = snapshot();
    const controller = new EnvironmentContextController({
      async snapshot() {
        return current;
      },
    });

    const first = await controller.capture(undefined);
    expect(first.changed).toBe(true);
    if (!first.changed) throw new Error("Expected initial environment message");

    const unchanged = await controller.capture(first.context);
    expect(unchanged).toEqual({ changed: false });

    current = snapshot({ currentDate: "2026-08-18", timezone: "America/New_York" });
    const changed = await controller.capture(first.context);
    expect(changed.changed).toBe(true);
    if (!changed.changed) throw new Error("Expected replacement environment message");
    expect(changed.context).toMatchObject({
      revision: 2,
      snapshot: {
        ...current,
        execution: { ...current.execution, shell: "zsh" },
      },
    });
    expect(renderEnvironmentContext(changed.context)).toContain('revision="2"');
    expect(renderEnvironmentContext(changed.context)).not.toContain("replaces=");
    expect(renderEnvironmentContext(changed.context)).toContain("<cwd>/workspace/project</cwd>");
  });

  it("wraps provider failures and rejects invalid required workspace facts", async () => {
    const unavailable = new EnvironmentContextController({
      async snapshot() {
        throw new Error("probe failed");
      },
    });
    await expect(unavailable.capture(undefined)).rejects.toMatchObject({
      code: "environment_context_unavailable",
      retryable: true,
    });

    const invalid = new EnvironmentContextController({
      async snapshot() {
        return { ...snapshot(), workspace: { cwd: "relative", roots: ["/workspace"] } };
      },
    });
    await expect(invalid.capture(undefined)).rejects.toBeInstanceOf(EnvironmentContextError);
    await expect(invalid.capture(undefined)).rejects.toMatchObject({
      code: "environment_context_invalid",
      field: "workspace.cwd",
      retryable: false,
    });

    const invalidDate = new EnvironmentContextController({
      async snapshot() {
        return snapshot({ currentDate: "2026-02-31" });
      },
    });
    await expect(invalidDate.capture(undefined)).rejects.toMatchObject({
      code: "environment_context_invalid",
      field: "time.currentDate",
      retryable: false,
    });
  });

  it("rejects a snapshot that cannot fit in the environment prompt budget", async () => {
    const oversized = new EnvironmentContextController({
      async snapshot() {
        return {
          ...snapshot(),
          workspace: {
            cwd: "/workspace/project",
            roots: [
              "/workspace",
              ...Array.from(
                { length: 300 },
                (_, index) => `/external/${index}/${"segment".repeat(12)}`,
              ),
            ],
          },
        };
      },
    });

    await expect(oversized.capture(undefined)).rejects.toMatchObject({
      code: "environment_context_invalid",
      field: "workspace.roots",
      retryable: false,
    });
  });
});
