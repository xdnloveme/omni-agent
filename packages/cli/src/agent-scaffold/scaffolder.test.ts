import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentManifest } from "@omni-agent/app";
import ts from "typescript";
import { createAgentScaffold } from "./scaffolder";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createAgentScaffold", () => {
  it("creates one minimal Manifest-first Agent Package", async () => {
    const directory = join(tmpdir(), `omni-agent-scaffold-${crypto.randomUUID()}`);
    directories.push(directory);

    const created = await createAgentScaffold({
      agentId: "release-notes",
      directory,
      frameworkVersion: "1.2.3",
    });

    expect(created.files).toEqual([
      "agent.yaml",
      "package.json",
      "tsconfig.json",
      "src/index.ts",
      "src/blueprint.ts",
      "src/components/tool-catalog.ts",
      "README.md",
    ]);
    const manifest = parseAgentManifest(
      await readFile(join(directory, "agent.yaml"), "utf8"),
      "agent.yaml",
    );
    expect(manifest.metadata).toEqual({ id: "release-notes", displayName: "Release Notes" });
    expect(manifest.composition.tools.sequence).toEqual([{ tool: "release-notes.echo" }]);
    const packageMetadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    expect(packageMetadata).toMatchObject({
      name: "@omni-agent/agent-release-notes",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      dependencies: { "@omni-agent/app": "^1.2.3", "@omni-agent/core": "^1.2.3" },
    });
    expect(await readFile(join(directory, "src/blueprint.ts"), "utf8")).not.toContain("maxTurns");
    for (const source of ["src/index.ts", "src/blueprint.ts", "src/components/tool-catalog.ts"]) {
      const result = ts.transpileModule(await readFile(join(directory, source), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: source,
        reportDiagnostics: true,
      });
      expect(result.diagnostics, source).toEqual([]);
    }
  });

  it("never overwrites an existing target", async () => {
    const directory = join(tmpdir(), `omni-agent-scaffold-${crypto.randomUUID()}`);
    directories.push(directory);
    await createAgentScaffold({ agentId: "first", directory, frameworkVersion: "1.0.0" });

    await expect(
      createAgentScaffold({ agentId: "second", directory, frameworkVersion: "1.0.0" }),
    ).rejects.toMatchObject({ code: "agent_scaffold_target_exists" });
    expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8"))).toMatchObject({
      name: "@omni-agent/agent-first",
    });
  });
});
