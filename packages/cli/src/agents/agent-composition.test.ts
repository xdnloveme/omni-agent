import { describe, expect, it } from "vitest";
import { createAgentComposition } from "./agent-composition";

describe("createAgentComposition", () => {
  it("loads an installed agent package through its factory", async () => {
    const composition = await createAgentComposition("financial-analysis");

    expect(composition.agentId).toBe("financial-analysis");
    expect(composition.extension.contributions.agents?.[0]?.definition.id).toBe(
      "financial-analysis",
    );
    expect(composition.extension.contributions.agents?.[0]?.definition.instructions).toContain(
      "read-only financial analysis agent",
    );
    expect(composition.skills).toBeUndefined();
  });

  it("rejects ids that could escape the package naming convention", async () => {
    await expect(createAgentComposition("../custom")).rejects.toThrow(
      "Invalid agent id: ../custom",
    );
  });
});
