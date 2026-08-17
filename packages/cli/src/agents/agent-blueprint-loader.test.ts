import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RejectingInteractionSurface } from "@omni-agent/core";
import { loadAgentBlueprint } from "./agent-blueprint-loader";

describe("loadAgentBlueprint", () => {
  it("loads an installed Agent Blueprint without an allowlist", async () => {
    const blueprint = await loadAgentBlueprint("financial-analysis");
    const module = await blueprint.build({
      cwd: process.cwd(),
      interaction: new RejectingInteractionSurface(),
    });

    expect(blueprint.id).toBe("financial-analysis");
    expect(module.id).toBe("financial-analysis");
    expect(module.extension.contributions.agents?.[0]?.definition.instructions).toContain(
      "read-only financial analysis agent",
    );
  });

  it("rejects ids that escape the package convention", async () => {
    await expect(loadAgentBlueprint("../custom")).rejects.toThrow("Invalid agent id: ../custom");
  });

  it("resolves an external Agent relative to the logical CLI installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-loader-"));
    try {
      const packageDirectory = join(root, "node_modules", "@omni-agent", "agent-fixture");
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: "@omni-agent/agent-fixture", type: "module", main: "index.js" }),
      );
      await writeFile(
        join(packageDirectory, "index.js"),
        'export const agentBlueprint = { id: "fixture", build() {} };\n',
      );
      const logicalCliEntry = join(root, "node_modules", "@omni-agent", "cli", "bin", "omni.js");

      await expect(
        loadAgentBlueprint("fixture", { resolutionBase: logicalCliEntry }),
      ).resolves.toMatchObject({ id: "fixture" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves external Agents from the package-manager-neutral Agent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-packages-"));
    try {
      const packageDirectory = join(root, "node_modules", "@omni-agent", "agent-fixture");
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: "@omni-agent/agent-fixture", type: "module", main: "index.js" }),
      );
      await writeFile(
        join(packageDirectory, "index.js"),
        'export const agentBlueprint = { id: "fixture", build() {} };\n',
      );

      await expect(
        loadAgentBlueprint("fixture", {
          resolutionBase: join(root, "unrelated", "omni.js"),
          agentPackagesDirectory: root,
        }),
      ).resolves.toMatchObject({ id: "fixture" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not hide initialization failures behind a lower-priority package", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-precedence-"));
    try {
      const primaryPackage = join(root, "primary", "node_modules", "@omni-agent", "agent-fixture");
      const fallbackPackage = join(
        root,
        "fallback",
        "node_modules",
        "@omni-agent",
        "agent-fixture",
      );
      await Promise.all([
        mkdir(primaryPackage, { recursive: true }),
        mkdir(fallbackPackage, { recursive: true }),
      ]);
      const metadata = JSON.stringify({
        name: "@omni-agent/agent-fixture",
        type: "module",
        main: "index.js",
      });
      await Promise.all([
        writeFile(join(primaryPackage, "package.json"), metadata),
        writeFile(join(primaryPackage, "index.js"), 'throw new Error("primary agent failed");\n'),
        writeFile(join(fallbackPackage, "package.json"), metadata),
        writeFile(
          join(fallbackPackage, "index.js"),
          'export const agentBlueprint = { id: "fixture", build() {} };\n',
        ),
      ]);

      await expect(
        loadAgentBlueprint("fixture", {
          resolutionBase: join(root, "primary", "bin", "omni.js"),
          agentPackagesDirectory: join(root, "fallback"),
        }),
      ).rejects.toMatchObject({ cause: { message: "primary agent failed" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
