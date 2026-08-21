import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AgentCompositionPlanner,
  parseAgentManifest,
  validateAgentBlueprintDescriptor,
} from "@omni-agent/app";
import { RejectingInteractionSurface } from "@omni-agent/core";
import { agentBlueprint } from "./blueprint";

// This executable follows the same Recipe -> Catalog -> Plan -> Blueprint chain as Runtime.
const manifestPath = fileURLToPath(new URL("../agent.yaml", import.meta.url));
const manifest = parseAgentManifest(await readFile(manifestPath, "utf8"), manifestPath);
const descriptor = validateAgentBlueprintDescriptor(agentBlueprint.descriptor);
const composition = new AgentCompositionPlanner().plan(manifest.composition, descriptor);
const module = await agentBlueprint.build({
  manifest,
  composition,
  cwd: process.cwd(),
  interaction: new RejectingInteractionSurface(),
});

console.log(
  JSON.stringify(
    {
      agentId: manifest.metadata.id,
      promptProfile: composition.prompt.profileId,
      toolComponents: composition.tools.componentIds,
      exposedTools: module.extension.contributions.tools?.map(({ name }) => name) ?? [],
    },
    null,
    2,
  ),
);
