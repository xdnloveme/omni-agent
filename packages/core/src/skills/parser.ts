import { readFile } from "node:fs/promises";
import { parseSkillMarkdown } from "./frontmatter";
import type { SkillSource } from "./types";

export interface SkillDraft {
  filePath: string;
  fallbackName: string;
  source: SkillSource;
  frontmatter: Record<string, unknown>;
  body: string;
}

export class SkillParser {
  async parse(filePath: string, fallbackName: string, source: SkillSource): Promise<SkillDraft> {
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseSkillMarkdown(raw);
    return {
      filePath,
      fallbackName,
      source,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    };
  }
}
