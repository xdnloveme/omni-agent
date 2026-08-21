import { describe, expect, it } from "vitest";
import { parseAgentManifest } from "../packages/app/src/assembly/agent-manifest-validator";
import { loadBuiltinAgentMetadata } from "../scripts/build-cli-distribution";

describe("Agent package distribution inputs", () => {
  it("injects both canonical built-in Manifests and package versions", async () => {
    const metadata = await loadBuiltinAgentMetadata();

    expect(Object.keys(metadata.manifests)).toEqual(["coding", "financial-analysis"]);
    expect(Object.keys(metadata.versions)).toEqual(["coding", "financial-analysis"]);
    for (const [agentId, rawManifest] of Object.entries(metadata.manifests)) {
      expect(parseAgentManifest(rawManifest, `builtin:${agentId}`).metadata.id).toBe(agentId);
      expect(metadata.versions[agentId]).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});
