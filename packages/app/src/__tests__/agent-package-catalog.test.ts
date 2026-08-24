import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPackageCatalog } from "../agent-packages/agent-package-catalog";

const roots: string[] = [];

afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__omniInvalidAgentExecuted;
  delete (globalThis as Record<string, unknown>).__omniMismatchedAgentExecuted;
  delete (globalThis as Record<string, unknown>).__omniV1AgentExecuted;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentPackageCatalog", () => {
  it("lists only explicit registrations without executing their modules", async () => {
    const loadModule = vi.fn(async () => ({ agentBlueprint: {} }));
    const catalog = new AgentPackageCatalog({
      registrations: [
        {
          agentId: "coding",
          bundledManifest: manifest("coding", "Coding"),
          bundledPackageVersion: "1.2.3",
          loadModule,
        },
      ],
    });

    await expect(catalog.list()).resolves.toEqual([
      {
        id: "coding",
        displayName: "Coding",
        description: "Coding Agent",
        packageName: "@omni-agent/agent-coding",
        packageVersion: "1.2.3",
      },
    ]);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("rejects duplicate explicit registrations atomically", () => {
    const registration = {
      agentId: "coding",
      bundledManifest: manifest("coding", "Coding"),
      bundledPackageVersion: "1.0.0",
      loadModule: async () => ({ agentBlueprint: {} }),
    };

    expect(() => new AgentPackageCatalog({ registrations: [registration, registration] })).toThrow(
      expect.objectContaining({ code: "agent_identity_mismatch" }),
    );
  });

  it("rejects a partial bundled registration instead of falling back to Node resolution", () => {
    expect(
      () =>
        new AgentPackageCatalog({
          registrations: [
            {
              agentId: "coding",
              bundledManifest: manifest("coding", "Coding"),
              loadModule: async () => ({ agentBlueprint: {} }),
            },
          ],
        }),
    ).toThrow(expect.objectContaining({ code: "agent_package_incompatible" }));
  });

  it("validates an external Manifest before executing package code", async () => {
    const root = await createExternalPackage(
      "invalid",
      "kind: Invalid\n",
      "globalThis.__omniInvalidAgentExecuted = true; export const agentBlueprint = {};\n",
    );
    const catalog = new AgentPackageCatalog({
      resolutionBases: [join(root, "module-resolver.cjs")],
    });

    await expect(catalog.load("invalid")).rejects.toMatchObject({
      code: "agent_manifest_invalid",
    });
    expect((globalThis as Record<string, unknown>).__omniInvalidAgentExecuted).toBeUndefined();
    await expect(catalog.list()).resolves.toEqual([]);
  });

  it("validates requested and Manifest identity before executing package code", async () => {
    const root = await createExternalPackage(
      "external",
      manifest("other", "Other"),
      "globalThis.__omniMismatchedAgentExecuted = true; export const agentBlueprint = {};\n",
    );
    const catalog = new AgentPackageCatalog({
      resolutionBases: [join(root, "module-resolver.cjs")],
    });

    await expect(catalog.load("external")).rejects.toMatchObject({
      code: "agent_identity_mismatch",
    });
    expect((globalThis as Record<string, unknown>).__omniMismatchedAgentExecuted).toBeUndefined();
  });

  it("reports a legacy external package without a Manifest export as incompatible", async () => {
    const root = await createExternalPackage(
      "legacy",
      undefined,
      "export const agentBlueprint = {};\n",
    );
    const catalog = new AgentPackageCatalog({
      resolutionBases: [join(root, "module-resolver.cjs")],
    });

    await expect(catalog.load("legacy")).rejects.toMatchObject({
      code: "agent_package_incompatible",
    });
  });

  it("rejects a v1 Manifest as incompatible before executing package code", async () => {
    const root = await createExternalPackage(
      "v1",
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
      "globalThis.__omniV1AgentExecuted = true; export const agentBlueprint = {};\n",
    );
    const catalog = new AgentPackageCatalog({
      resolutionBases: [join(root, "module-resolver.cjs")],
    });

    await expect(catalog.load("v1")).rejects.toMatchObject({
      code: "agent_package_incompatible",
    });
    expect((globalThis as Record<string, unknown>).__omniV1AgentExecuted).toBeUndefined();
  });

  it("distinguishes missing and invalid Blueprint exports", async () => {
    const missing = new AgentPackageCatalog({
      registrations: [registration("missing", async () => ({}))],
    });
    const invalid = new AgentPackageCatalog({
      registrations: [
        registration("invalid-blueprint", async () => ({
          agentBlueprint: { descriptor: {}, build() {} },
        })),
      ],
    });

    await expect(missing.load("missing")).rejects.toMatchObject({
      code: "agent_blueprint_missing",
    });
    await expect(invalid.load("invalid-blueprint")).rejects.toMatchObject({
      code: "agent_blueprint_invalid",
    });
  });

  it("rejects an invalid bundled package version before executing its module", async () => {
    const loadModule = vi.fn(async () => ({ agentBlueprint: {} }));
    const catalog = new AgentPackageCatalog({
      registrations: [
        {
          ...registration("invalid-version", loadModule),
          bundledPackageVersion: "latest",
        },
      ],
    });

    await expect(catalog.load("invalid-version")).rejects.toMatchObject({
      code: "agent_package_incompatible",
    });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("loads an installed external package by id without making it discoverable", async () => {
    const root = await createExternalPackage(
      "external",
      manifest("external", "External"),
      [
        "export const agentBlueprint = {",
        "  descriptor: {",
        "    promptProfiles: [{ id: 'external.default', displayName: 'External', description: 'External' }],",
        "    promptContributors: [], toolBundles: [], tools: [],",
        "    capabilities: { skills: [], artifactRecovery: [] },",
        "  },",
        "  async build() { throw new Error('Blueprint build is not part of Catalog loading'); },",
        "};",
        "",
      ].join("\n"),
      "1.2.3",
    );
    const catalog = new AgentPackageCatalog({
      resolutionBases: [join(root, "module-resolver.cjs")],
    });

    await expect(catalog.list()).resolves.toEqual([]);
    await expect(catalog.load("external")).resolves.toMatchObject({
      packageName: "@omni-agent/agent-external",
      packageVersion: "1.2.3",
      manifest: { metadata: { id: "external" } },
    });
  });
});

async function createExternalPackage(
  agentId: string,
  rawManifest: string | undefined,
  moduleSource: string,
  version = "1.0.0",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-catalog-"));
  roots.push(root);
  const packageName = `@omni-agent/agent-${agentId}`;
  const packageRoot = join(root, "node_modules", "@omni-agent", `agent-${agentId}`);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version,
      type: "module",
      exports: {
        ".": "./index.mjs",
        ...(rawManifest === undefined ? {} : { "./agent.yaml": "./agent.yaml" }),
      },
    }),
  );
  if (rawManifest !== undefined) {
    await writeFile(join(packageRoot, "agent.yaml"), rawManifest);
  }
  await writeFile(join(packageRoot, "index.mjs"), moduleSource);
  return root;
}

function manifest(agentId: string, displayName: string): string {
  return [
    "apiVersion: omni-agent/v2",
    "kind: Agent",
    "metadata:",
    `  id: ${agentId}`,
    `  displayName: ${displayName}`,
    "runtime:",
    "  blueprintApiVersion: 2",
    `description: ${displayName} Agent`,
    "composition:",
    "  prompt:",
    `    profile: ${agentId}.default`,
    "    contributors: []",
    "  tools:",
    "    sequence: []",
    "  capabilities: {}",
    "",
  ].join("\n");
}

function registration(
  agentId: string,
  loadModule: () => Promise<{ readonly agentBlueprint?: unknown }>,
) {
  return {
    agentId,
    bundledManifest: manifest(agentId, agentId),
    bundledPackageVersion: "1.0.0",
    loadModule,
  };
}
