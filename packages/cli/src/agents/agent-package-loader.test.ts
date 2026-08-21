import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentPackage } from "./agent-package-loader";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadAgentPackage", () => {
  it("loads a built-in package from its canonical Manifest", async () => {
    const loaded = await loadAgentPackage("coding");
    expect(loaded.manifest.metadata.id).toBe("coding");
    expect(loaded.packageName).toBe("@omni-agent/agent-coding");
    expect(loaded.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("loads every bundled Agent through the same Manifest-first contract", async () => {
    const loaded = await Promise.all([
      loadAgentPackage("coding"),
      loadAgentPackage("financial-analysis"),
    ]);

    expect(loaded.map(({ manifest }) => manifest.metadata.id)).toEqual([
      "coding",
      "financial-analysis",
    ]);
    expect(loaded.every(({ blueprint }) => typeof blueprint.build === "function")).toBe(true);
  });

  it("does not execute external package code before Manifest validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-package-"));
    roots.push(root);
    const packageRoot = join(root, "node_modules", "@omni-agent", "agent-invalid");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@omni-agent/agent-invalid",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.mjs", "./agent.yaml": "./agent.yaml" },
      }),
    );
    await writeFile(join(packageRoot, "agent.yaml"), "kind: Invalid\n");
    await writeFile(
      join(packageRoot, "index.mjs"),
      "globalThis.__omniInvalidAgentExecuted = true; export const agentBlueprint = {};\n",
    );

    await expect(
      loadAgentPackage("invalid", { agentPackagesDirectory: root }),
    ).rejects.toMatchObject({ code: "agent_manifest_invalid" });
    expect((globalThis as Record<string, unknown>).__omniInvalidAgentExecuted).toBeUndefined();
  });

  it("reports a legacy external package without a Manifest export as incompatible", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-package-"));
    roots.push(root);
    const packageRoot = join(root, "node_modules", "@omni-agent", "agent-legacy");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@omni-agent/agent-legacy",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.mjs" },
      }),
    );
    await writeFile(join(packageRoot, "index.mjs"), "export const agentBlueprint = {};\n");

    await expect(
      loadAgentPackage("legacy", { agentPackagesDirectory: root }),
    ).rejects.toMatchObject({ code: "agent_package_incompatible" });
  });

  it("reports an external Manifest v1 package as incompatible without importing code", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-package-"));
    roots.push(root);
    const packageRoot = join(root, "node_modules", "@omni-agent", "agent-v1");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@omni-agent/agent-v1",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.mjs", "./agent.yaml": "./agent.yaml" },
      }),
    );
    await writeFile(
      join(packageRoot, "agent.yaml"),
      [
        "apiVersion: omni-agent/v1",
        "kind: Agent",
        "metadata:",
        "  id: v1",
        "  displayName: V1",
        "runtime:",
        "  blueprintApiVersion: 2",
        "description: Legacy",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(packageRoot, "index.mjs"),
      "globalThis.__omniV1AgentExecuted = true; export const agentBlueprint = {};\n",
    );

    await expect(loadAgentPackage("v1", { agentPackagesDirectory: root })).rejects.toMatchObject({
      code: "agent_package_incompatible",
    });
    expect((globalThis as Record<string, unknown>).__omniV1AgentExecuted).toBeUndefined();
  });

  it("loads a valid external Agent package after validating its Manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-package-"));
    roots.push(root);
    const packageRoot = join(root, "node_modules", "@omni-agent", "agent-external");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@omni-agent/agent-external",
        version: "1.2.3",
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
        "    promptProfiles: [{ id: 'external.default', displayName: 'External prompt', description: 'External prompt' }],",
        "    promptContributors: [], toolBundles: [], tools: [],",
        "    capabilities: { skills: [], artifactRecovery: [] },",
        "  },",
        "  async build() { throw new Error('not executed by loader'); },",
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      loadAgentPackage("external", { agentPackagesDirectory: root }),
    ).resolves.toMatchObject({
      packageName: "@omni-agent/agent-external",
      packageVersion: "1.2.3",
      manifest: { metadata: { id: "external" } },
    });
  });

  it("distinguishes an invalid Blueprint descriptor from a missing Blueprint export", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-package-"));
    roots.push(root);
    const packageRoot = join(root, "node_modules", "@omni-agent", "agent-invalid-blueprint");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@omni-agent/agent-invalid-blueprint",
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
        "  id: invalid-blueprint",
        "  displayName: Invalid Blueprint",
        "runtime:",
        "  blueprintApiVersion: 2",
        "description: Invalid Blueprint",
        "composition:",
        "  prompt:",
        "    profile: invalid-blueprint.default",
        "    contributors: []",
        "  tools:",
        "    sequence: []",
        "  capabilities: {}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(packageRoot, "index.mjs"),
      "export const agentBlueprint = { descriptor: {}, build() {} };\n",
    );

    await expect(
      loadAgentPackage("invalid-blueprint", { agentPackagesDirectory: root }),
    ).rejects.toMatchObject({
      code: "agent_blueprint_invalid",
      cause: expect.objectContaining({ message: expect.stringContaining("Missing fields") }),
    });
  });
});
