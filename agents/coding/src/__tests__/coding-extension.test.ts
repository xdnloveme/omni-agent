import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillRuntime } from "@omni-agent/core";
import { createCodingExtension } from "../extension";
import { CODING_SYSTEM_PROMPT } from "../prompt";

describe("coding extension", () => {
  it("preserves the default prompt and tool order", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omni-agent-coding-"));
    const skills = new SkillRuntime({ cwd });
    await skills.initialize();

    const bundle = createCodingExtension(skills, cwd);
    const tools = bundle.extension.contributions.tools ?? [];

    expect(tools.map((tool) => tool.name)).toEqual([
      "bash",
      "file_read",
      "file_edit",
      "file_write",
      "glob",
      "grep",
      "web_fetch",
      "web_search",
      "skill_read",
    ]);
    expect(await bundle.buildSystemPrompt()).toContain(CODING_SYSTEM_PROMPT.trim());
  });
});
