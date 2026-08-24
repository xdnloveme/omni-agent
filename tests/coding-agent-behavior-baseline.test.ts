import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentBlueprint } from "../agents/coding/src/blueprint";
import { CODING_SYSTEM_PROMPT } from "../agents/coding/src/prompt";
import {
  AgentCompositionPlanner,
  parseAgentManifest,
  validateAgentBlueprintDescriptor,
} from "../packages/app/src/index";
import { RejectingInteractionSurface } from "../packages/core/src/index";
import { HOST_COMMAND_NAMES } from "../packages/cli/src/commands/index";
import { CODING_AGENT_BEHAVIOR_BASELINE as baseline } from "./fixtures/coding-agent-behavior-baseline";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Coding Agent M0 behavior baseline", () => {
  it("freezes Manifest identity, tool order, command order, and prompt composition", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omni-coding-baseline-"));
    directories.push(cwd);
    const manifestPath = join(import.meta.dirname, "../agents/coding/agent.yaml");
    const manifest = parseAgentManifest(await readFile(manifestPath, "utf8"), manifestPath);
    const descriptor = validateAgentBlueprintDescriptor(agentBlueprint.descriptor);
    const composition = new AgentCompositionPlanner().plan(manifest.composition, descriptor);

    const module = await agentBlueprint.build({
      manifest,
      composition,
      cwd,
      interaction: new RejectingInteractionSurface(),
      execution: {
        async getMode() {
          return "controlled";
        },
      },
    });
    const contribution = module.extension.contributions.agents?.[0];
    if (!contribution) throw new Error("Coding Agent contribution is missing");
    const prompt =
      typeof contribution.definition.instructions === "function"
        ? await contribution.definition.instructions({ cwd })
        : contribution.definition.instructions;

    expect(module.extension.manifest.id).toBe(baseline.agentId);
    expect(manifest.apiVersion).toBe(baseline.manifestApiVersion);
    expect(manifest.runtime.blueprintApiVersion).toBe(baseline.blueprintApiVersion);
    expect(contribution.definition.description).toBe(baseline.description);
    expect(createHash("sha256").update(CODING_SYSTEM_PROMPT).digest("hex")).toBe(
      baseline.systemPromptDigest,
    );
    expect(module.extension.contributions.tools?.map(({ name }) => name)).toEqual(
      baseline.toolNames,
    );
    expect(HOST_COMMAND_NAMES).toEqual(baseline.hostCommandNames);
    const positions = baseline.promptAnchors.map((anchor) => prompt.indexOf(anchor));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});
