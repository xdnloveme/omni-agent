import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("Agent composition architecture", () => {
  it("keeps semantic composition in the Planner and executable loading in the Loader", async () => {
    const planner = await source("packages/app/src/assembly/agent-assembly-planner.ts");
    const loader = await source("packages/cli/src/agents/agent-package-loader.ts");
    const assembler = await source("packages/app/src/assembly/agent-runtime-assembler.ts");

    expect(planner).toContain("AgentCompositionPlanner");
    expect(planner).not.toMatch(/\.build\s*\(/);
    expect(loader).toContain("validateAgentBlueprintDescriptor");
    expect(loader).not.toContain("AgentCompositionPlanner");
    expect(assembler).not.toContain("manifest.composition");
  });

  it("keeps removed Recipe and positional Toolset paths out of production", async () => {
    const files = [
      ...(await sourceFiles(join(root, "agents"))),
      ...(await sourceFiles(join(root, "packages"))),
    ].filter(isProduction);
    const violations: string[] = [];
    for (const file of files) {
      const value = await readFile(file, "utf8");
      if (/coding\.local|localCodingToolset|localReadonlyToolset|webResearchToolset/.test(value)) {
        violations.push(relative(root, file));
      }
    }
    expect(violations).toEqual([]);

    const contracts = await source("packages/app/src/assembly/contracts.ts");
    const validator = await source("packages/app/src/assembly/agent-manifest-validator.ts");
    expect(contracts).not.toMatch(/readonly bundles|readonly include/);
    expect(validator).not.toContain('["bundles", "include"]');
  });

  it("keeps inspection on the Planner path without building Runtime resources", async () => {
    const controller = await source("packages/cli/src/agent-inspection/controller.ts");
    expect(controller).toContain("AgentCompositionPlanner");
    expect(controller).not.toMatch(/\.build\s*\(/);
    expect(controller).not.toMatch(/AgentFactory|ModelService|Session|SkillRuntime/);
  });

  it("keeps v1 and concrete Agent turn limits out of the production contract", async () => {
    const files = [
      ...(await sourceFiles(join(root, "agents"))),
      ...(await sourceFiles(join(root, "packages", "app", "src"))),
      ...(await sourceFiles(join(root, "packages", "cli", "src"))),
    ].filter(isProduction);
    const violations: string[] = [];
    for (const file of files) {
      const value = await readFile(file, "utf8");
      if (/omni-agent\/v1/.test(value) || (file.includes("/agents/") && /maxTurns/.test(value))) {
        violations.push(relative(root, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps composition evidence outside model-cache identity and policy", async () => {
    const cacheFiles = await sourceFiles(join(root, "packages", "models", "src", "cache"));
    const combined = (
      await Promise.all(cacheFiles.filter(isProduction).map((file) => readFile(file, "utf8")))
    ).join("\n");
    expect(combined).not.toMatch(
      /AgentComposition|ResolvedAgentComposition|AgentBlueprintDescriptor|AssemblyDigest/,
    );
  });

  it("keeps Agent package roots on the single Blueprint assembly path", async () => {
    for (const path of ["agents/coding/src/index.ts", "agents/financial-analysis/src/index.ts"]) {
      const entry = await source(path);
      expect(entry).toContain('export { agentBlueprint } from "./blueprint"');
      expect(entry).not.toMatch(/export .*create(?:Coding|FinancialAnalysis)(?:Agent|Extension)/);
    }
  });
});

async function source(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

function isProduction(path: string): boolean {
  return (
    !path.endsWith(".test.ts") &&
    !path.includes("/__tests__/") &&
    !path.includes("/evals/") &&
    !path.includes("/dist/")
  );
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
          : Promise.resolve(
              path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".yaml") ? [path] : [],
            );
      }),
    )
  ).flat();
}
