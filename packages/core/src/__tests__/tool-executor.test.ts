import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../tools/executor";
import type { AgentTool } from "../types";

const echoTool: AgentTool = {
  name: "echo",
  description: "Echo input",
  schema: { type: "object" },
  async execute(input) {
    return { content: [{ type: "text", text: String(input.value) }], isError: false };
  },
};

describe("ToolExecutor", () => {
  it("executes a registered tool and records duration", async () => {
    const execution = await new ToolExecutor().execute([echoTool], "echo", { value: "ok" });
    expect(execution.result).toMatchObject({ isError: false, content: [{ text: "ok" }] });
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns a model-visible error for an unknown tool", async () => {
    const execution = await new ToolExecutor().execute([], "missing", {});
    expect(execution.result.isError).toBe(true);
    expect(execution.result.content[0].text).toBe("Tool not found: missing");
  });

  it("enforces policy before execution", async () => {
    const executor = new ToolExecutor({
      policy: { evaluate: () => ({ allowed: false, reason: "read only" }) },
    });
    const execution = await executor.execute([echoTool], "echo", {});
    expect(execution.result.content[0].text).toBe("Tool denied: read only");
  });

  it("validates strict tool inputs before execution", async () => {
    const strictTool = {
      ...echoTool,
      strict: true,
      schema: { type: "object", required: ["value"] },
    };
    const execution = await new ToolExecutor().execute([strictTool], "echo", {});
    expect(execution.result.content[0].text).toBe("Invalid tool input: value is required");
  });
});
