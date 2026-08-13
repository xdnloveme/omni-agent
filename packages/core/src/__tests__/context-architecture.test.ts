import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const contextRoot = join(import.meta.dirname, "..", "context");
const coreRoot = join(contextRoot, "..");
const repositoryRoot = join(coreRoot, "..", "..", "..");

describe("context architecture", () => {
  it("keeps contracts, the generic policy hook, and compression implementations separated", async () => {
    const files = await sourceFiles(contextRoot);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const path = relative(contextRoot, file);
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
      if (path.startsWith("contracts/")) {
        for (const specifier of imports) {
          if (
            specifier.includes("/assembly/") ||
            specifier.includes("/compression/") ||
            specifier.includes("/policy/") ||
            specifier.includes("/runtime/") ||
            /(?:agent|session|app|provider)(?:\/|$)/i.test(specifier) ||
            specifier === "../../types"
          ) {
            violations.push(`${path} -> ${specifier}`);
          }
        }
      }
      if (path.startsWith("policy/")) {
        for (const specifier of imports) {
          if (
            specifier.includes("/assembly/") ||
            specifier.includes("/compression/") ||
            specifier.includes("/checkpoints/")
          ) {
            violations.push(`${path} -> ${specifier}`);
          }
        }
      }
      if (path.startsWith("compression/")) {
        for (const specifier of imports) {
          if (/(?:agent|session|app|provider)(?:\/|$)/i.test(specifier)) {
            violations.push(`${path} -> ${specifier}`);
          }
        }
      }
      if (path.startsWith("assembly/")) {
        for (const specifier of imports) {
          if (
            specifier.includes("/compression/") ||
            specifier.includes("/checkpoints/") ||
            specifier.includes("/policy/")
          ) {
            violations.push(`${path} -> ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);

    const contracts = await readFile(join(contextRoot, "contracts", "types.ts"), "utf8");
    const publicStageOptions = contracts.match(
      /export interface ContextPolicyStageOptions \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(publicStageOptions).toBeDefined();
    expect(publicStageOptions).not.toMatch(
      /sourceMessages|middlewareDigest|precedingStages|sessionRevision/,
    );
  });

  it("keeps model contracts and the Context Engine free of higher-level runtime types", async () => {
    const modelContracts = await readFile(join(coreRoot, "models", "runtime.ts"), "utf8");
    const engine = await readFile(join(contextRoot, "runtime", "engine.ts"), "utf8");
    const contextSources = await Promise.all(
      (await sourceFiles(contextRoot)).map((file) => readFile(file, "utf8")),
    );

    expect(modelContracts).not.toMatch(/from\s+["'][^"']*context/);
    expect(modelContracts).not.toContain("RegisteredAgentTool");
    expect(engine).not.toMatch(/WorkingConversation|RegisteredAgentTool/);
    expect(contextSources.join("\n")).not.toMatch(
      /WorkingConversationSnapshot|RegisteredAgentTool/,
    );
  });

  it("has one transcript projection, one tool projection, and no legacy message contracts", async () => {
    const productionFiles = (
      await Promise.all(
        [join(repositoryRoot, "packages"), join(repositoryRoot, "agents")].map(sourceFiles),
      )
    )
      .flat()
      .filter((file) => !file.includes("/__tests__/") && !file.includes("/dist/"));
    const sources = await Promise.all(
      productionFiles.map(async (file) => ({ file, source: await readFile(file, "utf8") })),
    );
    const legacy =
      /\b(?:AgentMessage|UserAgentMessage|AssistantAgentMessage|ToolResultAgentMessage|SessionMessage)\b/;

    expect(
      sources
        .filter(({ source }) => legacy.test(source))
        .map(({ file }) => relative(repositoryRoot, file)),
    ).toEqual([]);
    expect(
      sources.filter(({ source }) => /function\s+toContextMessages\s*\(/.test(source)),
    ).toHaveLength(1);
    expect(
      sources.filter(({ source }) => /function\s+toModelToolSpec\s*\(/.test(source)),
    ).toHaveLength(1);
    expect(sources.some(({ source }) => /projectModelTools/.test(source))).toBe(false);
    expect(
      productionFiles
        .map((file) => relative(repositoryRoot, file))
        .filter(
          (file) =>
            file === "packages/core/src/llm-context.ts" ||
            file === "packages/core/src/models/messages.ts",
        ),
    ).toEqual([]);
    expect(
      sources
        .filter(
          ({ source }) =>
            source.includes("RegisteredAgentTool") && source.includes("ModelToolSpec"),
        )
        .map(({ file }) => relative(repositoryRoot, file))
        .filter(
          (file) =>
            file !== "packages/core/src/agent/contextInput.ts" &&
            file !== "packages/core/src/index.ts",
        ),
    ).toEqual([]);

    const transcriptAndModelContextAllowlist = new Set([
      "packages/core/src/context/assembly/messageProjection.ts",
      "packages/core/src/context/assembly/entryProjection.ts",
      "packages/core/src/context/contracts/types.ts",
      "packages/core/src/index.ts",
      "packages/core/src/messages/index.ts",
      "packages/core/src/messages/modelContext.ts",
      "packages/core/src/models/runtime.ts",
      "packages/models/src/runtime/message-mapper.ts",
    ]);
    expect(
      sources
        .filter(
          ({ source }) =>
            source.includes("TranscriptMessage") && source.includes("ModelContextMessage"),
        )
        .map(({ file }) => relative(repositoryRoot, file))
        .filter((file) => !transcriptAndModelContextAllowlist.has(file)),
    ).toEqual([]);

    expect(
      sources
        .filter(({ source }) => /FullHistoryContextStrategy|ContextStrategyPort/.test(source))
        .map(({ file }) => relative(repositoryRoot, file)),
    ).toEqual([]);
    expect(
      sources
        .filter(({ source }) => /\bbeforeModel\b|\bstrategyName\b|\bstrategyVersion\b/.test(source))
        .map(({ file }) => relative(repositoryRoot, file)),
    ).toEqual([]);
  });

  it("prevents workspace consumers from deep-importing Context", async () => {
    const consumerRoots = ["app", "models", "cli"].map((name) =>
      join(repositoryRoot, "packages", name, "src"),
    );
    consumerRoots.push(join(repositoryRoot, "agents"));
    const files = (await Promise.all(consumerRoots.map(sourceFiles))).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (match[1].includes("@omni-agent/core/context/")) {
          violations.push(`${relative(repositoryRoot, file)} -> ${match[1]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("exposes Context to the rest of Core only through its index", async () => {
    const sourceRoot = join(contextRoot, "..");
    const files = (await sourceFiles(sourceRoot)).filter(
      (file) => !file.startsWith(contextRoot) && !file.includes("/__tests__/"),
    );
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
      for (const specifier of imports) {
        if (/context\/(?!index(?:\.js)?$)/.test(specifier)) {
          violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
    expect(await readFile(join(sourceRoot, "types.ts"), "utf8")).not.toContain(
      "WorkingConversation",
    );
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(path.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
}
