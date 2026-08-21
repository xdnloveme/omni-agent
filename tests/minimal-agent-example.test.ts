import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentCompositionPlanner,
  parseAgentManifest,
  validateAgentBlueprintDescriptor,
} from "../packages/app/src/index";
import { RejectingInteractionSurface } from "../packages/core/src/index";
import { agentBlueprint } from "../examples/minimal-agent/src/index";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("minimal Agent example", () => {
  it("executes the documented Recipe -> Plan -> Blueprint chain", async () => {
    const manifestPath = join(root, "examples/minimal-agent/agent.yaml");
    const manifest = parseAgentManifest(await readFile(manifestPath, "utf8"), manifestPath);
    const descriptor = validateAgentBlueprintDescriptor(agentBlueprint.descriptor);
    const composition = new AgentCompositionPlanner().plan(manifest.composition, descriptor);
    const module = await agentBlueprint.build({
      manifest,
      composition,
      cwd: root,
      interaction: new RejectingInteractionSurface(),
    });

    expect(composition.tools).toEqual({
      componentIds: ["minimal.echo"],
      toolNames: ["echo_text"],
    });
    expect(module.extension.contributions.agents?.[0]?.tools).toEqual({
      include: ["echo_text"],
    });
    await expect(
      module.extension.contributions.tools?.[0]?.execute(
        { text: "hello" },
        { cwd: root, agentId: "minimal-example", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "hello" }], isError: false });
  });
});
