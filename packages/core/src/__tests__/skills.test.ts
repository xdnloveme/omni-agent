import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  stat,
  rename,
  symlink,
  utimes,
} from "node:fs/promises";
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
  it("uses current invocation policy and update diagnostics for slash preload", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skill-slash-update-"));
    const file = await writeSkill(path.join(cwd, ".agents/skills"), "demo");
    await writeFile(
      file,
      "---\nname: demo\ndescription: valid\nuser-invocable: false\n---\nOld body",
    );
    const registry = new SkillRegistry({ cwd });
    await registry.initialize();
    await writeSkill(path.join(cwd, ".agents/skills"), "demo", "Current body");
    expect((await registry.resolveSlashPreload("/demo"))?.modelInput).toContain("Current body");
    await writeFile(file, "---\nname: demo\n---\nInvalid body");
    const preload = await registry.resolveSlashPreload("/demo");
    expect(preload?.modelInput).toContain("Current body");
    expect(preload?.modelInput).toContain("last validated version");
    expect(preload?.modelInput).not.toContain("Invalid body");
  });

  it("activates validated edits on read and keeps content-identical versions cached", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skill-updates-"));
    const file = await writeSkill(path.join(cwd, ".agents/skills"), "demo", "Old body");
    const registry = new SkillRegistry({ cwd });
    await registry.initialize();
    const first = await registry.read("demo");
    await utimes(file, new Date(), new Date(Date.now() + 1000));
    const same = await registry.read("demo");
    expect(same.status).toBe("cached");
    expect(same.skill.version).toBe(first.skill.version);
    expect(same.skill.loadedAt).toBe(first.skill.loadedAt);
    await writeFile(file, "---\nname: demo\ndescription: updated description\n---\nNew body");
    const next = await registry.read("demo");
    expect(next.skill.body).toBe("New body");
    expect(next.skill.description).toBe("updated description");
    expect(next.skill.version).not.toBe(first.skill.version);
    expect(registry.get("demo")?.description).toBe("updated description");
    expect(next.renderedText).toContain("supersedes earlier loaded versions");
    expect(first.skill.body).toContain("Old body");
  });

  it.each([true, false])(
    "rejects invalid reload without mixing versions (cached: %s)",
    async (cached) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "omni-skill-invalid-"));
      const file = await writeSkill(path.join(cwd, ".agents/skills"), "demo", "Validated body");
      const registry = new SkillRegistry({ cwd });
      await registry.initialize();
      if (cached) await registry.read("demo");
      await writeFile(file, "---\nname: demo\n---\nRejected body");
      expect((await registry.reload()).diagnostics).toContainEqual(
        expect.objectContaining({ code: "missing-description" }),
      );
      if (cached) {
        const result = await registry.read("demo");
        expect(result.skill.body).toContain("Validated body");
        expect(result.renderedText).not.toContain("Rejected body");
        expect(result.diagnostic?.message).toContain("last validated version");
        expect(registry.diagnostics()).toContainEqual(result.diagnostic);
      } else await expect(registry.read("demo")).rejects.toThrow("description");
    },
  );

  it("revalidates changed invocation flags before exposing the new body", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skill-policy-"));
    const file = await writeSkill(path.join(cwd, ".agents/skills"), "demo");
    const registry = new SkillRegistry({ cwd });
    await registry.initialize();
    await registry.read("demo");
    await writeFile(
      file,
      "---\nname: demo\ndescription: updated\ndisable-model-invocation: true\n---\nExplicit only",
    );
    await expect(registry.read("demo")).rejects.toThrow("disabled for model invocation");
    expect((await registry.read("demo", { explicit: true })).skill.body).toBe("Explicit only");
  });

  it.each(["parent", "source"])(
    "does not rebase the trusted boundary after %s replacement",
    async (target) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "omni-skill-boundary-"));
      const source = path.join(cwd, ".agents/skills");
      const file = await writeSkill(source, "demo", "Safe body");
      const registry = new SkillRegistry({ cwd });
      await registry.initialize();
      await registry.read("demo");
      const external = path.join(cwd, "outside");
      await writeSkill(external, "demo", "Outside body");
      const replaced = target === "parent" ? path.dirname(file) : source;
      await rename(replaced, replaced + "-saved");
      await symlink(target === "parent" ? path.join(external, "demo") : external, replaced);
      if (target === "source")
        expect((await registry.reload()).diagnostics).toContainEqual(
          expect.objectContaining({ code: "read-error" }),
        );
      const result = await registry.read("demo");
      expect(result.skill.body).toContain("Safe body");
      expect(result.renderedText).not.toContain("Outside body");
      expect(result.diagnostic).toBeDefined();
    },
  );

  it("allows a regular replacement file and an in-root SKILL.md link", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omni-skill-links-"));
    const file = await writeSkill(path.join(cwd, ".agents/skills"), "demo", "Original");
    const registry = new SkillRegistry({ cwd });
    await registry.initialize();
    const replacement = file + ".next";
    await writeFile(replacement, "---\nname: demo\ndescription: valid\n---\nReplacement");
    await rename(replacement, file);
    expect((await registry.read("demo")).skill.body).toBe("Replacement");
    await rename(file, file + ".body");
    await symlink(file + ".body", file);
    expect((await registry.read("demo")).skill.body).toBe("Replacement");
  });
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
    expect(matchingSkills[0].filePath).toBe(await realpath(projectPath));
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
          skills: [await metadataFor(activePath)],
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

async function metadataFor(filePath: string): Promise<SkillMetadata> {
  filePath = await realpath(filePath);
  const root = path.dirname(filePath);
  const info = await stat(root);
  return {
    sourceRoot: { path: root, dev: info.dev, ino: info.ino },
    name: "frontend-design",
    description: "frontend-design description",
    filePath,
    baseDir: path.dirname(filePath),
    source: { scope: SkillSourceScope.Project, path: path.dirname(filePath) },
    userInvocable: true,
    disableModelInvocation: false,
  };
}
