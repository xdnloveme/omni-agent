import { describe, expect, it } from "vitest";
import { createAgentAssemblySnapshot } from "./assembly-digest";
import type { AgentAssemblyFacts } from "./contracts";

const facts: AgentAssemblyFacts = {
  agentId: "coding",
  packageName: "@omni-agent/agent-coding",
  packageVersion: "1.0.0",
  manifestApiVersion: "omni-agent/v2",
  blueprintApiVersion: 2,
  workspaceId: "workspace",
  model: { vendorId: "vendor", connectionId: "default", modelId: "model" },
  extensions: [
    {
      id: "coding",
      version: "1.0.0",
      sourceOriginId: "builtin-coding",
      requirement: "required",
    },
  ],
  composition: {
    promptProfileId: "coding.default",
    promptContributorIds: ["workspace.agents-md", "skills.catalog"],
    toolComponentIds: ["coding.file-read", "coding.bash"],
    capabilityIds: ["skills.local"],
  },
  toolNames: ["file_read", "bash"],
  systemPromptDigest: "prompt-digest",
};

describe("AgentAssemblySnapshot", () => {
  it("produces a stable non-self-referential frozen digest", () => {
    const first = createAgentAssemblySnapshot(facts);
    const second = createAgentAssemblySnapshot(structuredClone(facts));
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.toolNames)).toBe(true);
    expect(Object.isFrozen(first.model)).toBe(true);
    expect(Object.isFrozen(first.extensions[0])).toBe(true);
    expect(first).not.toHaveProperty("token");
  });

  it("preserves business order in the digest", () => {
    const first = createAgentAssemblySnapshot(facts);
    const reordered = createAgentAssemblySnapshot({
      ...facts,
      toolNames: [...facts.toolNames].reverse(),
    });
    expect(reordered.digest).not.toBe(first.digest);
  });

  it("treats extension order as assembly behavior and excludes non-projected fields", () => {
    const extended: AgentAssemblyFacts = {
      ...facts,
      extensions: [
        ...facts.extensions,
        {
          id: "workspace",
          version: "1.0.0",
          sourceOriginId: "workspace",
          requirement: "optional",
        },
      ],
    };
    const first = createAgentAssemblySnapshot({
      ...extended,
      token: "must-not-leak",
    } as AgentAssemblyFacts & { token: string });
    const reordered = createAgentAssemblySnapshot({
      ...extended,
      extensions: [...extended.extensions].reverse(),
    });

    expect(reordered.digest).not.toBe(first.digest);
    expect(JSON.stringify(first)).not.toContain("must-not-leak");
  });
});
