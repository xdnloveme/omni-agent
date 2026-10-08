import { describe, expect, it, vi } from "vitest";
import { dispatchPostEventHooks } from "../hooks";
import type { AgentConfig } from "../types";

describe("observational Hooks", () => {
  it("gives typed Hooks a detached deeply immutable event and contains failures", async () => {
    const diagnostics: unknown[] = [];
    const event = {
      type: "run.failed" as const,
      failure: { code: "failure", message: "original", retryable: false },
    };
    const config = configWithHooks([
      {
        id: "typed",
        events: ["run.failed"],
        handle(value) {
          expect(Object.isFrozen(value)).toBe(true);
          expect(Object.isFrozen((value as typeof event).failure)).toBe(true);
          (value as typeof event).failure.message = "changed";
        },
      },
    ]);
    await dispatchPostEventHooks(event, context(config, diagnostics));
    expect(event.failure.message).toBe("original");
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "hook_execution_failed", hookId: "typed" }),
    ]);
  });

  it("publishes contained failures through the configured runtime diagnostic sink", async () => {
    const diagnostic = vi.fn();
    const config = {
      ...configWithHooks([
        {
          id: "failing",
          events: ["run.completed"],
          handle() {
            throw new Error("hook failed");
          },
        },
      ]),
      onHookDiagnostic: diagnostic,
    } satisfies AgentConfig;
    const ctx = context(config, []);
    await dispatchPostEventHooks({ type: "run.completed" }, { ...ctx, diagnostic: undefined });
    expect(diagnostic).toHaveBeenCalledWith({
      code: "hook_execution_failed",
      hookId: "failing",
      message: "hook failed",
    });
  });

  it("runs command Hooks through the coordinator with hook origin and discards output", async () => {
    const authorizeAndRun = vi.fn(async function* () {
      yield {
        type: "tool_end",
        toolName: "audit",
        toolCallId: "hook",
        result: { content: [{ type: "text", text: "private output" }], isError: false },
        durationMs: 1,
        metrics: { executed: true, accessMs: 0, executionMs: 1, totalMs: 1 },
      };
    });
    const coordinator = {
      prepareBatch: vi.fn(async (request) => ({
        calls: [
          {
            preparation: "ready",
            toolName: "audit",
            toolCallId: "hook",
            input: request.calls[0].input,
          },
        ],
      })),
      authorizeAndRun,
    };
    const config = configWithHooks([
      {
        id: "command",
        events: ["run.completed"],
        toolName: "audit",
        input: () => ({ message: "done" }),
      },
    ]);
    const ctx = context(config, []);
    await dispatchPostEventHooks(
      { type: "run.completed" },
      {
        ...ctx,
        coordinator: coordinator as never,
        environment: {
          ...ctx.environment,
          onPermissionResolved: async () => {
            throw new Error("recursive hook");
          },
        },
      },
    );
    expect(coordinator.prepareBatch).toHaveBeenCalledWith(
      expect.objectContaining({ environment: expect.objectContaining({ origin: "hook" }) }),
    );
    expect(authorizeAndRun).toHaveBeenCalledOnce();
    expect(coordinator.prepareBatch.mock.calls[0]?.[0].environment).not.toHaveProperty(
      "onPermissionResolved",
    );
  });

  it("contains failures in the observational diagnostic sink", async () => {
    const config = configWithHooks([
      {
        id: "failing",
        events: ["run.completed"],
        handle() {
          throw new Error("hook failure");
        },
      },
    ]);
    await expect(
      dispatchPostEventHooks(
        { type: "run.completed" },
        {
          ...context(config, []),
          diagnostic: () => {
            throw new Error("sink failure");
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});

function configWithHooks(hooks: AgentConfig["hooks"]): AgentConfig {
  return { model: {} as AgentConfig["model"], systemPrompt: "", tools: [], hooks };
}
function context(config: AgentConfig, diagnostics: unknown[]) {
  return {
    config,
    coordinator: {} as never,
    environment: {
      agentId: "coding",
      workspaceId: "workspace",
      workspaceRoot: "/workspace",
      cwd: "/workspace",
      middleware: [],
      lifecycleAdapters: [],
      origin: "hook" as const,
    },
    diagnostic: (value: unknown) => diagnostics.push(value),
  };
}
