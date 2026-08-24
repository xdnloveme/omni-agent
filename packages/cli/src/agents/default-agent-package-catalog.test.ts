import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultAgentPackageCatalog } from "./default-agent-package-catalog";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createDefaultAgentPackageCatalog", () => {
  it("discovers and loads both built-in Agent packages", async () => {
    const catalog = createDefaultAgentPackageCatalog();

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({ id: "coding", packageName: "@omni-agent/agent-coding" }),
      expect.objectContaining({
        id: "financial-analysis",
        packageName: "@omni-agent/agent-financial-analysis",
      }),
    ]);
    const loaded = await Promise.all([catalog.load("coding"), catalog.load("financial-analysis")]);
    expect(loaded.map(({ manifest }) => manifest.metadata.id)).toEqual([
      "coding",
      "financial-analysis",
    ]);
  });

  it("keeps an installed external Agent loadable by exact id without listing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-cli-catalog-"));
    roots.push(root);
    const packageRoot = join(root, "node_modules", "@omni-agent", "agent-external");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@omni-agent/agent-external",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.mjs", "./agent.yaml": "./agent.yaml" },
      }),
    );
    await writeFile(
      join(packageRoot, "agent.yaml"),
      [
        "apiVersion: omni-agent/v2",
        "kind: Agent",
        "metadata:",
        "  id: external",
        "  displayName: External",
        "runtime:",
        "  blueprintApiVersion: 2",
        "description: External Agent",
        "composition:",
        "  prompt:",
        "    profile: external.default",
        "    contributors: []",
        "  tools:",
        "    sequence: []",
        "  capabilities: {}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(packageRoot, "index.mjs"),
      [
        "export const agentBlueprint = {",
        "  descriptor: {",
        "    promptProfiles: [{ id: 'external.default', displayName: 'External', description: 'External' }],",
        "    promptContributors: [], toolBundles: [], tools: [],",
        "    capabilities: { skills: [], artifactRecovery: [] },",
        "  },",
        "  async build() { throw new Error('not called by Catalog loading'); },",
        "};",
        "",
      ].join("\n"),
    );
    const catalog = createDefaultAgentPackageCatalog({ agentPackagesDirectory: root });

    await expect(catalog.list()).resolves.not.toContainEqual(
      expect.objectContaining({ id: "external" }),
    );
    await expect(catalog.load("external")).resolves.toMatchObject({
      packageName: "@omni-agent/agent-external",
      manifest: { metadata: { id: "external" } },
    });
  });
});
