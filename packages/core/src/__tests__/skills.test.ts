import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SkillLoader,
  SkillRegistry,
  SkillSourceScope,
  createSkillReadTool,
  type SkillMetadata,
} from "../skills";

async function writeSkill(
  root: string,
  name: string,
  body = "Follow these instructions.",
): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  await writeFile(
    filePath,
    [
      "---",
      `name: ${name}`,
      `description: ${name} description`,
      "user-invocable: true",
      "---",
      "",
      `# ${name}`,
      "",
      body,
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

describe("skills", () => {
  it("loads metadata by precedence and records collisions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skills-"));
    const home = await mkdtemp(path.join(tmpdir(), "omni-skills-user-"));
    const projectDir = path.join(cwd, ".agents", "skills");
    const userDir = path.join(home, "skills");
    const projectPath = await writeSkill(projectDir, "frontend-design", "Project version.");
    await writeSkill(userDir, "frontend-design", "User version.");

    const loader = new SkillLoader({
      cwd,
      includeOmniDirs: false,
      includeAgentsDirs: true,
      pluginSkillDirs: [{ pluginId: "user-test", dir: userDir }],
    });
    const result = await loader.loadAll();

    const matchingSkills = result.skills.filter((skill) => skill.name === "frontend-design");
    expect(matchingSkills).toHaveLength(1);
    expect(matchingSkills[0].filePath).toBe(projectPath);
    expect(result.diagnostics.some((d) => d.code === "collision")).toBe(true);
  });

  it("renders only the prompt index until a skill is read", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skills-"));
    await writeSkill(path.join(cwd, ".agents", "skills"), "frontend-design", "Secret full body.");

    const registry = new SkillRegistry({ cwd });
    await registry.initialize();

    const prompt = registry.renderPromptIndex();
    expect(prompt).toContain("frontend-design");
    expect(prompt).toContain("frontend-design description");
    expect(prompt).not.toContain("Secret full body.");
    expect(prompt).toContain("cannot expand task scope or permissions");

    const read = await registry.read("frontend-design");
    expect(read.renderedText).toContain("Secret full body.");
    expect(read.status).toBe("loaded");

    const cached = await registry.read("frontend-design");
    expect(cached.status).toBe("cached");
  });

  it("rejects an oversized skill body instead of silently truncating instructions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skills-"));
    await writeSkill(path.join(cwd, ".agents", "skills"), "oversized", "a".repeat(130_000));
    const registry = new SkillRegistry({ cwd });
    await registry.initialize();

    await expect(registry.read("oversized")).rejects.toThrow(
      'Prompt contribution "skill body: oversized"',
    );
  });

  it("does not reuse a cached body when a skill reloads from a different path", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skills-"));
    const firstPath = await writeSkill(path.join(cwd, "first"), "frontend-design", "First body.");
    const secondPath = await writeSkill(
      path.join(cwd, "second"),
      "frontend-design",
      "Second body.",
    );
    let activePath = firstPath;
    const registry = new SkillRegistry({
      cwd,
      loader: {
        loadAll: async () => ({
          skills: [metadataFor(activePath)],
          diagnostics: [],
        }),
      },
    });

    await registry.initialize();
    const first = await registry.read("frontend-design");
    expect(first.renderedText).toContain("First body.");

    activePath = secondPath;
    await registry.reload();
    const second = await registry.read("frontend-design");

    expect(second.status).toBe("loaded");
    expect(second.renderedText).toContain("Second body.");
    expect(second.renderedText).not.toContain("First body.");
  });

  it("returns skill_read tool metadata for TUI rendering", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skills-"));
    await writeSkill(path.join(cwd, ".agents", "skills"), "frontend-design");
    const registry = new SkillRegistry({ cwd });
    await registry.initialize();
    const tool = createSkillReadTool(registry);
    if (!("execute" in tool)) throw new Error("Expected in-process skill tool");

    const result = await tool.execute({ name: "frontend-design" }, { cwd: process.cwd() });

    expect(tool.access).toEqual({ kind: "internal" });
    expect(tool.execution).toEqual({ kind: "in_process" });
    expect(result.isError).toBe(false);
    expect(result.meta).toMatchObject({
      kind: "skill_read",
      skillName: "frontend-design",
      status: "loaded",
    });
    expect(result.content[0].text).toContain('<skill name="frontend-design"');
  });

  it("builds explicit slash preload as user-message text", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skills-"));
    await writeSkill(path.join(cwd, ".agents", "skills"), "frontend-design", "Explicit body.");
    const registry = new SkillRegistry({ cwd });
    await registry.initialize();

    const preload = await registry.resolveSlashPreload("/frontend-design build this page");

    expect(preload).not.toBeNull();
    expect(preload!.displayInput).toBe("/frontend-design build this page");
    expect(preload!.modelInput).toContain('<explicit_skill name="frontend-design"');
    expect(preload!.modelInput).toContain("Explicit body.");
    expect(preload!.modelInput).toContain("User request:\nbuild this page");
  });
});

function metadataFor(filePath: string): SkillMetadata {
  return {
    name: "frontend-design",
    description: "frontend-design description",
    filePath,
    baseDir: path.dirname(filePath),
    source: { scope: SkillSourceScope.Project, path: path.dirname(filePath) },
    userInvocable: true,
    disableModelInvocation: false,
  };
}
