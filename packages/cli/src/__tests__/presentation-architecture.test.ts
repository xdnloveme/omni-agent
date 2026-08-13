import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..");

describe("stream presentation architecture", () => {
  it("keeps runtime packages and agents independent from CLI rendering", async () => {
    const roots = ["core", "app", "models", "tools"].map((name) =>
      join(repositoryRoot, "packages", name, "src"),
    );
    roots.push(join(repositoryRoot, "agents"));
    const violations: string[] = [];
    for (const file of (await Promise.all(roots.map(sourceFiles))).flat()) {
      if (file.includes("/__tests__/")) continue;
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (/(?:@omni-agent\/cli|\/cli\/|pi-tui|chalk)/.test(match[1])) {
          violations.push(`${relative(repositoryRoot, file)} -> ${match[1]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps generic TUI components free of feature and domain knowledge", async () => {
    const tuiRoot = join(repositoryRoot, "packages", "cli", "src", "interaction", "tui");
    const sources = await Promise.all(
      (await sourceFiles(tuiRoot))
        .filter((file) => !file.endsWith(".test.ts"))
        .map((file) => readFile(file, "utf8")),
    );
    expect(sources.join("\n")).not.toMatch(
      /@omni-agent\/app|agents\/|ContextDecision|SKILL_TOOL_NAME|file_read|file_edit|file_write|artifact_projection|heavy_checkpoint/,
    );
  });

  it("has one presenter path and no legacy command or skill suppression path", async () => {
    const productionFiles = (await sourceFiles(join(repositoryRoot, "packages"))).filter(
      (file) =>
        !file.includes("/__tests__/") && !file.includes("/dist/") && !file.endsWith(".test.ts"),
    );
    const sources = await Promise.all(
      productionFiles.map(async (file) => ({ file, source: await readFile(file, "utf8") })),
    );
    const combined = sources.map(({ source }) => source).join("\n");
    const chat = await readFile(
      join(repositoryRoot, "packages", "cli", "src", "modes", "chat.ts"),
      "utf8",
    );
    const agentLoop = await readFile(
      join(repositoryRoot, "packages", "core", "src", "agent-loop.ts"),
      "utf8",
    );

    expect(chat).not.toMatch(/SKILL_TOOL_NAME|shouldSuppressToolPreview|agentConfig\.systemPrompt/);
    expect(agentLoop).not.toMatch(
      /file_read|skill_read|artifact_projection|skill_projection|thinking_projection|heavy_checkpoint|cacheHitRate/,
    );
    expect(combined).not.toMatch(/\bCommandTui\b|ctx\.tui\b|shouldSuppressToolPreview/);
    expect(combined.match(/class\s+StreamPresentationRouter\b/g)).toHaveLength(1);
    expect(combined.match(/class\s+CompressionEventPresenter\b/g)).toHaveLength(1);
    expect(combined.match(/class\s+ToolEventPresenter\b/g)).toHaveLength(1);
    expect(combined.match(/cacheReadTokens\s*\/\s*totalPromptTokens/g)).toHaveLength(1);
  });

  it("keeps Session storage independent from progress, cache, and presentation DTOs", async () => {
    const sessionSources = await Promise.all(
      (await sourceFiles(join(repositoryRoot, "packages", "core", "src", "session"))).map((file) =>
        readFile(file, "utf8"),
      ),
    );
    expect(sessionSources.join("\n")).not.toMatch(
      /ContextProgress|ContextCompression|ModelCacheReport|DisclosureViewModel/,
    );
  });
});

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
