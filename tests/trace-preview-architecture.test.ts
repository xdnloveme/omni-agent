import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..");

describe("trace preview architecture", () => {
  it("keeps runtime and business layers independent from UI", async () => {
    const roots = ["core", "app", "models", "tools"].map((name) =>
      join(repositoryRoot, "packages", name, "src"),
    );
    roots.push(join(repositoryRoot, "agents"));
    const violations: string[] = [];
    for (const file of (await Promise.all(roots.map(sourceFiles))).flat()) {
      if (file.endsWith(".test.ts") || file.includes("/__tests__/")) continue;
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (/(?:@omni-agent\/ui|\/packages\/ui\/|\/browser\/trace\/)/.test(match[1])) {
          violations.push(`${relative(repositoryRoot, file)} -> ${match[1]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the browser host behind the App query port", async () => {
    const host = await source("packages/ui/src/browser/trace/host/trace-preview-server.ts");
    const appIndex = await source("packages/app/src/index.ts");

    expect(host).toMatch(/import type \{ TraceQueryPort \} from "@omni-agent\/app"/);
    expect(host).not.toMatch(
      /LocalTraceStore|TraceQueryService|TraceStorageLayout|assertSafePath|layout\./,
    );
    expect(appIndex).not.toMatch(/LocalTraceStore|TraceQueryService|TraceStorageLayout/);
  });

  it("keeps CLI preview code as composition and process lifecycle only", async () => {
    const previewDirectory = join(repositoryRoot, "packages/cli/src/tracing-preview");
    const entries = await readdir(previewDirectory, { withFileTypes: true });
    const command = await source("packages/cli/src/tracing-preview/preview-command.ts");

    expect(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["preview-command.ts"]);
    expect(command).toContain("@omni-agent/ui/trace-preview-server");
    expect(command).not.toMatch(
      /\bHono\b|serveStatic|\.get\(["']\/api|TraceQueryPort|Waterfall|React|Vite/,
    );
  });
});

async function source(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory() && ["dist", "node_modules"].includes(entry.name)) return [];
      return entry.isDirectory()
        ? sourceFiles(path)
        : path.endsWith(".ts") || path.endsWith(".tsx")
          ? [path]
          : [];
    }),
  );
  return nested.flat();
}
