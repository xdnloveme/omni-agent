import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..");
const coreSource = join(repositoryRoot, "packages", "core", "src");
const cacheSource = join(repositoryRoot, "packages", "models", "src", "cache");

describe("model cache architecture", () => {
  it("keeps Context and Session independent from cache runtime implementations", async () => {
    const contextSources = await readSources(join(coreSource, "context"));
    const sessionSources = await readSources(join(coreSource, "session"));

    expect([...contextSources, ...sessionSources].join("\n")).not.toMatch(
      /models\/cache|models\/src\/cache|@omni-agent\/models/,
    );
  });

  it("keeps the Agent loop free of cache policy, fingerprint, state, and Provider mapping", async () => {
    const source = await readFile(join(coreSource, "agent-loop.ts"), "utf8");

    expect(source).not.toMatch(
      /DefaultModelCachePolicy|ModelCacheFingerprinter|RuntimeModelCacheState|toProviderCacheOptions|cache_control|prompt_cache_key/,
    );
  });

  it("keeps cache implementations independent from Context, Session, and App", async () => {
    const files = await sourceFiles(cacheSource);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
      for (const specifier of imports) {
        if (/(?:context|session|app|agent-loop)(?:\/|$)/i.test(specifier)) {
          violations.push(`${relative(cacheSource, file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("has one scope generator and one request fingerprinter", async () => {
    const productionSources = await readSources(
      join(repositoryRoot, "packages"),
      (file) => !file.includes("/__tests__/") && !file.includes("/dist/"),
    );
    const combined = productionSources.join("\n");

    expect(combined.match(/function\s+createScopeId\s*\(/g)).toHaveLength(1);
    expect(combined.match(/class\s+ModelCacheFingerprinter\b/g)).toHaveLength(1);
    expect(combined).not.toMatch(/cache_control|prompt_cache_key/);
  });
});

async function readSources(
  root: string,
  include: (file: string) => boolean = () => true,
): Promise<string[]> {
  const files = (await sourceFiles(root)).filter(include);
  return Promise.all(files.map((file) => readFile(file, "utf8")));
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(path.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
}
