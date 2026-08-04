import { describe, expect, it } from "vitest";
import type { AgentExtension } from "../extensions/types";
import { ExtensionManager } from "../extensions/extension-manager";

function extension(id: string, activate?: () => void): AgentExtension {
  return {
    manifest: { id, version: "1.0.0", apiVersion: 1 },
    contributions: {
      tools: [{
        name: `${id}_tool`,
        description: "test",
        schema: { type: "object" },
        async execute() {
          return { content: [{ type: "text", text: "ok" }], isError: false };
        },
      }],
      agents: [{
        definition: { id: `${id}_agent`, description: "test", instructions: "test" },
        tools: { include: [`${id}_tool`] },
      }],
    },
    activate,
  };
}

describe("ExtensionManager", () => {
  it("registers and resolves declared contributions", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    await manager.register(extension("sample"));
    const agent = manager.agents.get("sample_agent");
    expect(agent).toBeDefined();
    expect(manager.tools.resolve(agent!.tools).map((tool) => tool.name)).toEqual(["sample_tool"]);
  });

  it("rolls back all contributions when activation fails", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    await expect(manager.register(extension("broken", () => {
      throw new Error("activation failed");
    }))).rejects.toThrow("activation failed");
    expect(manager.agents.has("broken_agent")).toBe(false);
    expect(manager.tools.has("broken_tool")).toBe(false);
  });

  it("rejects an agent that exposes an unknown tool before registration", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken");
    broken.contributions.agents![0].tools = { include: ["missing_tool"] };

    await expect(manager.register(broken)).rejects.toThrow(
      "Agent broken_agent references unknown tool: missing_tool",
    );
    expect(manager.agents.has("broken_agent")).toBe(false);
    expect(manager.tools.has("broken_tool")).toBe(false);
  });

  it("isolates optional extension failures as diagnostics", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    await manager.registerOptional(extension("broken", () => {
      throw new Error("activation failed");
    }), "local.mjs");
    expect(manager.diagnostics).toEqual([expect.objectContaining({
      extensionId: "broken",
      source: "local.mjs",
      message: "activation failed",
    })]);
  });
});
