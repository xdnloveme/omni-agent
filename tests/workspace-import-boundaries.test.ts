import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

type Layer =
  | "core"
  | "tools"
  | "models"
  | "app"
  | "agentHost"
  | "imGateway"
  | "agents"
  | "ui"
  | "cli"
  | "host"
  | "examples";

const roots: readonly { readonly directory: string; readonly layer: Layer }[] = [
  { directory: "packages/core", layer: "core" },
  { directory: "packages/tools", layer: "tools" },
  { directory: "packages/models", layer: "models" },
  { directory: "packages/app", layer: "app" },
  { directory: "packages/agent-host", layer: "agentHost" },
  { directory: "packages/im-gateway", layer: "imGateway" },
  { directory: "agents", layer: "agents" },
  { directory: "packages/ui", layer: "ui" },
  { directory: "packages/cli", layer: "cli" },
  { directory: "apps/omni", layer: "host" },
  { directory: "examples", layer: "examples" },
];

const allowed: Readonly<Record<Layer, ReadonlySet<Layer>>> = {
  core: new Set(),
  tools: new Set(["core"]),
  models: new Set(["core"]),
  app: new Set(["core", "models"]),
  agentHost: new Set(["app"]),
  imGateway: new Set(["agentHost", "core"]),
  agents: new Set(["app", "core", "tools"]),
  ui: new Set(["app", "core"]),
  cli: new Set(["app", "core", "tools", "agents"]),
  host: new Set(["app", "agentHost", "imGateway", "cli", "core", "tools", "ui"]),
  examples: new Set(["app", "core", "tools"]),
};

describe("workspace import boundaries", () => {
  it("enforces the documented dependency direction using TypeScript imports", async () => {
    const violations: string[] = [];
    for (const owner of roots) {
      const ownerRoot = join(root, owner.directory);
      for (const file of (await sourceFiles(ownerRoot)).filter(isProduction)) {
        const source = await readFile(file, "utf8");
        const imports = ts.preProcessFile(source, true, true).importedFiles;
        for (const imported of imports) {
          const target = importedLayer(file, imported.fileName);
          if (target && target !== owner.layer && !allowed[owner.layer].has(target)) {
            violations.push(
              `${relative(root, file)}: ${owner.layer} must not import ${target} (${imported.fileName})`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

function importedLayer(importer: string, specifier: string): Layer | undefined {
  if (specifier === "@omni-agent/agent-host") return "agentHost";
  if (specifier === "@omni-agent/im-gateway") return "imGateway";
  if (specifier.startsWith("@omni-agent/agent-")) return "agents";
  const workspacePackage = /^@omni-agent\/(core|tools|models|app|ui|cli)(?:\/|$)/.exec(specifier);
  if (workspacePackage) return workspacePackage[1] as Layer;
  if (!specifier.startsWith(".")) return undefined;
  const targetPath = resolve(importer, "..", specifier);
  return roots.find(({ directory }) => inside(targetPath, join(root, directory)))?.layer;
}

function inside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

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
