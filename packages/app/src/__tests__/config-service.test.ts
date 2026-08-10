import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "../config/config-service";
import type { ModelSelection } from "../models/model-service";
import { AtomicJsonFile } from "../persistence/atomic-json-file";

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

  it("clears Agent overrides in both scopes without changing shared or sibling models", async () => {
    const { service, projectPath, globalPath } = await fixture();
    await writeConfig(globalPath, model("global"), {
      coding: { model: model("global-coding") },
      sibling: { model: model("global-sibling") },
    });
    await writeConfig(projectPath, model("project"), {
      coding: { model: model("project-coding") },
    });

    await service.clearAgentModelOverrides("coding");

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      version: 3,
      model: model("global"),
      agents: { sibling: { model: model("global-sibling") } },
    });
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      version: 3,
      model: model("project"),
    });
  });

  it("restores the first scope when clearing the second scope fails", async () => {
    const { service, projectPath, globalPath } = await fixture();
    await writeConfig(globalPath, model("global"), {
      coding: { model: model("global-coding") },
    });
    await writeConfig(projectPath, model("project"), {
      coding: { model: model("project-coding") },
    });
    const write = AtomicJsonFile.prototype.write;
    let writeCount = 0;
    vi.spyOn(AtomicJsonFile.prototype, "write").mockImplementation(function (
      this: AtomicJsonFile<unknown>,
      value,
    ) {
      writeCount += 1;
      if (writeCount === 2) return Promise.reject(new Error("project write failed"));
      return write.call(this, value);
    });

    await expect(service.clearAgentModelOverrides("coding")).rejects.toThrow(
      "project write failed",
    );

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      version: 3,
      model: model("global"),
      agents: { coding: { model: model("global-coding") } },
    });
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      version: 3,
      model: model("project"),
      agents: { coding: { model: model("project-coding") } },
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
