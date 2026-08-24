import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("Agent composition boundaries", () => {
  it("keeps App independent from concrete Agents and source adapters away from registries", async () => {
    const appFiles = await sourceFiles(join(root, "packages", "app", "src"));
    const violations: string[] = [];
    for (const file of appFiles.filter(isProduction)) {
      const source = await readFile(file, "utf8");
      if (/(?:from\s*|import\()\s*["'][^"']*(?:@omni-agent\/agent-|agents\/)/.test(source)) {
        violations.push(relative(root, file));
      }
    }
    const sourceLoader = await readFile(
      join(root, "packages", "app", "src", "assembly", "extension-source-loader.ts"),
      "utf8",
    );
    expect(violations).toEqual([]);
    expect(sourceLoader).not.toMatch(/Registry|ExtensionManager|AgentApplication|TraceStore/);
  });

  it("keeps Agent packages independent from CLI, UI, other Agents, and process cwd", async () => {
    const violations: string[] = [];
    for (const file of (await sourceFiles(join(root, "agents"))).filter(isProduction)) {
      const source = await readFile(file, "utf8");
      if (/@omni-agent\/(?:cli|ui)|\bprocess\.cwd\(\)/.test(source)) {
        violations.push(relative(root, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps assembly mechanics behind the App package boundary", async () => {
    const publicApi = await readFile(join(root, "packages", "app", "src", "index.ts"), "utf8");
    for (const internal of [
      "AssemblyInputResolver",
      "AgentAssemblyPlanner",
      "AgentRuntimeAssembler",
      "AssemblyTransaction",
      "createAgentAssemblySnapshot",
      "ResolvedAgentAssemblyPlan",
      "AgentAssemblyEnvironment",
    ]) {
      expect(publicApi).not.toContain(internal);
    }
  });

  it("keeps Assembly evidence outside model-cache identity and policy", async () => {
    const cacheFiles = await sourceFiles(join(root, "packages", "models", "src", "cache"));
    const combined = (
      await Promise.all(cacheFiles.filter(isProduction).map((file) => readFile(file, "utf8")))
    ).join("\n");

    expect(combined).not.toMatch(/AgentAssembly|assemblyDigest|assemblySnapshot/);
  });
});

function isProduction(path: string): boolean {
  return !path.endsWith(".test.ts") && !path.includes("/__tests__/") && !path.includes("/evals/");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        if (entry.name === "dist" || entry.name === "node_modules") return Promise.resolve([]);
        return entry.isDirectory()
          ? sourceFiles(path)
          : Promise.resolve(path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : []);
      }),
    )
  ).flat();
}
