import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../config/config-service";
import type { ModelSelection } from "../models/model-service";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function model(modelId: string): ModelSelection {
  return { vendorId: "vendor", connectionId: "default", modelId };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-config-"));
  const cwd = join(root, "project");
  const globalDirectory = join(root, "global");
  await Promise.all([mkdir(cwd), mkdir(globalDirectory)]);
  directories.push(root);
  return {
    cwd,
    globalDirectory,
    projectPath: join(cwd, "omni.config.json"),
    globalPath: join(globalDirectory, "config.json"),
    service: new ConfigService({ cwd, globalDirectory }),
  };
}

async function writeConfig(
  path: string,
  shared: ModelSelection,
  agents?: Record<string, { model: ModelSelection }>,
) {
  await writeFile(path, JSON.stringify({ version: 3, model: shared, agents }));
}

describe("ConfigService v3", () => {
  it("resolves project Agent, global Agent, project shared, then global shared", async () => {
    const { service, projectPath, globalPath } = await fixture();
    await writeConfig(globalPath, model("global"), {
      financial: { model: model("global-agent") },
    });
    await writeConfig(projectPath, model("project"), {
      coding: { model: model("project-agent") },
    });

    await expect(service.resolveModel("coding")).resolves.toEqual(model("project-agent"));
    await expect(service.resolveModel("financial")).resolves.toEqual(model("global-agent"));
    await expect(service.resolveModel("other")).resolves.toEqual(model("project"));
  });

  it("saves one Agent override without replacing shared or sibling configuration", async () => {
    const { service, projectPath } = await fixture();
    await writeConfig(projectPath, model("shared"), {
      coding: { model: model("coding") },
    });

    await service.saveAgentModel("financial", model("financial"));
    const saved = JSON.parse(await readFile(projectPath, "utf8"));

    expect(saved).toEqual({
      version: 3,
      model: model("shared"),
      agents: {
        coding: { model: model("coding") },
        financial: { model: model("financial") },
      },
    });
  });

  it("removes an override and falls back to the shared model", async () => {
    const { service, projectPath } = await fixture();
    await writeConfig(projectPath, model("shared"), {
      coding: { model: model("coding") },
    });

    await service.removeAgentModel("coding");

    await expect(service.resolveModel("coding")).resolves.toEqual(model("shared"));
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      version: 3,
      model: model("shared"),
    });
  });

  it("changes the shared model without changing Agent overrides", async () => {
    const { service, projectPath } = await fixture();
    await writeConfig(projectPath, model("old"), {
      coding: { model: model("coding") },
    });

    await service.saveSharedModel(model("new"));

    await expect(service.resolveModel("coding")).resolves.toEqual(model("coding"));
    await expect(service.resolveModel("financial")).resolves.toEqual(model("new"));
  });

  it("rejects version 2 without migrating or rewriting it", async () => {
    const { service, projectPath } = await fixture();
    const original = JSON.stringify({ version: 2, model: model("legacy") });
    await writeFile(projectPath, original);

    await expect(service.resolveModel("coding")).resolves.toBeNull();
    expect(service.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid_config", source: "project" }),
    ]);
    await expect(readFile(projectPath, "utf8")).resolves.toBe(original);
  });

  it("rejects invalid Agent IDs in configuration and write operations", async () => {
    const { service, projectPath } = await fixture();
    await writeConfig(projectPath, model("shared"), {
      "../coding": { model: model("invalid") },
    });

    await expect(service.resolveModel("coding")).resolves.toBeNull();
    await expect(service.saveAgentModel("../coding", model("invalid"))).rejects.toThrow(
      "Invalid agent id",
    );
  });
});
