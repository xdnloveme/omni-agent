import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "../config/config-service";
import type { ModelSelection } from "../models/model-service";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
  await writeFile(path, JSON.stringify({ model: shared, agents }));
}

describe("ConfigService", () => {
  it("writes new configuration globally by default without creating a project file", async () => {
    const { service, projectPath, globalPath } = await fixture();

    await service.saveSharedModel(model("global"));

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      version: 3,
      model: model("global"),
    });
    await expect(readFile(projectPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("uses a valid project Agent override even when the lower-priority global layer is invalid", async () => {
    const { service, projectPath, globalPath } = await fixture();
    await writeFile(globalPath, "invalid json");
    await writeConfig(projectPath, model("project"), {
      coding: { model: model("project-agent") },
    });

    await expect(service.resolveModelConfiguration("coding")).resolves.toEqual({
      selection: model("project-agent"),
      scope: "project",
      kind: "agent",
    });
  });

  it("does not skip an invalid global layer when it could contain a higher-priority Agent override", async () => {
    const { service, projectPath, globalPath } = await fixture();
    await writeFile(globalPath, "invalid json");
    await writeConfig(projectPath, model("project"));

    await expect(service.resolveModel("coding")).resolves.toBeNull();
  });

  it("saves one Agent override without replacing shared or sibling configuration", async () => {
    const { service, projectPath } = await fixture();
    await writeConfig(projectPath, model("shared"), {
      coding: { model: model("coding") },
    });

    await service.saveAgentModel("financial", model("financial"), { scope: "project" });
    const saved = JSON.parse(await readFile(projectPath, "utf8"));

    expect(saved).toEqual({
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

    await service.removeAgentModel("coding", { scope: "project" });

    await expect(service.resolveModel("coding")).resolves.toEqual(model("shared"));
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      model: model("shared"),
    });
  });

  it("changes the shared model without changing Agent overrides", async () => {
    const { service, projectPath } = await fixture();
    await writeConfig(projectPath, model("old"), {
      coding: { model: model("coding") },
    });

    await service.saveSharedModel(model("new"), { scope: "project" });

    await expect(service.resolveModel("coding")).resolves.toEqual(model("coding"));
    await expect(service.resolveModel("financial")).resolves.toEqual(model("new"));
  });

  it("rejects an unsupported internal version without rewriting it", async () => {
    const { service, projectPath } = await fixture();
    const original = JSON.stringify({ version: 2, model: model("legacy") });
    await writeFile(projectPath, original);

    await expect(service.resolveModel("coding")).resolves.toBeNull();
    expect(service.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid_config", source: "project" }),
    ]);
    await expect(readFile(projectPath, "utf8")).resolves.toBe(original);
  });

  it("accepts the internal version marker while keeping it out of project writes", async () => {
    const { service, projectPath } = await fixture();
    await writeFile(projectPath, JSON.stringify({ version: 3, model: model("legacy") }));

    await expect(service.resolveModel("coding")).resolves.toEqual(model("legacy"));
    await service.saveSharedModel(model("current"), { scope: "project" });

    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      model: model("current"),
    });
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
