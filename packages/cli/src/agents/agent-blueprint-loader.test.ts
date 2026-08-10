import { describe, expect, it } from "vitest";
import { loadAgentBlueprint } from "./agent-blueprint-loader";

describe("loadAgentBlueprint", () => {
  it("loads an installed Agent Blueprint without an allowlist", async () => {
    const blueprint = await loadAgentBlueprint("financial-analysis");
    const module = await blueprint.build({ cwd: process.cwd() });

    expect(blueprint.id).toBe("financial-analysis");
    expect(module.id).toBe("financial-analysis");
    expect(module.extension.contributions.agents?.[0]?.definition.instructions).toContain(
      "read-only financial analysis agent",
    );
  });

  it("rejects ids that escape the package convention", async () => {
    await expect(loadAgentBlueprint("../custom")).rejects.toThrow("Invalid agent id: ../custom");
  });
});
