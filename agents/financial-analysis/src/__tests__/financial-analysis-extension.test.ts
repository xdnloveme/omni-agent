import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RejectingInteractionSurface } from "@omni-agent/core";
import {
  AgentCompositionPlanner,
  parseAgentManifest,
  validateAgentBlueprintDescriptor,
} from "@omni-agent/app";
import { agentBlueprint } from "../blueprint";

const legacyPrompt = `You are a read-only financial analysis agent. Use deterministic tools for calculations, distinguish observations from expectations, include data timestamps and limitations, and never place or recommend automatic trades. Investigate available facts before asking the user. Use request_user_input only when different answers materially change the analysis, scope, compatibility, or risk. A successful request_user_input result contains authoritative clarification from the current user but never changes runtime access boundaries or bypasses execution policy. If clarification is skipped, use the lowest-impact reasonable assumptions and state them explicitly.`;
const legacyDescription =
  "Read-only financial analysis agent focused on deterministic technical indicators.";

describe("financial analysis extension", () => {
  it("preserves the real Manifest behavior except for the approved turn-limit removal", async () => {
    const manifestPath = join(import.meta.dirname, "../../agent.yaml");
    const manifest = parseAgentManifest(await readFile(manifestPath, "utf8"), manifestPath);
    const composition = new AgentCompositionPlanner().plan(
      manifest.composition,
      validateAgentBlueprintDescriptor(agentBlueprint.descriptor),
    );
    const extension = agentBlueprint.build({
      manifest,
      composition,
      cwd: "/workspace",
      interaction: new RejectingInteractionSurface(),
      execution: {
        async getMode() {
          return "controlled";
        },
      },
    }).extension;
    const definition = extension.contributions.agents?.[0]?.definition;

    expect(definition?.description).toBe(legacyDescription);
    expect(definition?.instructions).toBe(legacyPrompt);
    expect(extension.contributions.tools?.map((tool) => tool.name)).toEqual([
      "financial_compute_technical_indicators",
      "request_user_input",
    ]);
    expect(extension.contributions.agents?.[0]?.tools.include).toEqual([
      "financial_compute_technical_indicators",
      "request_user_input",
    ]);
    expect(definition?.maxTurns).toBeUndefined();
  });
});
