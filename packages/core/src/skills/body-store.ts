import { readFile, stat } from "node:fs/promises";
import { parseSkillMarkdown } from "./frontmatter";
import { renderLoadedSkill } from "./prompt";
import type { LoadedSkill, SkillMetadata, SkillReadResult } from "./types";
import { SkillReadStatus } from "./constants";
import { assertPromptContributionBudget, PROMPT_CONTRIBUTION_BUDGETS } from "../promptBudget";
import { estimateContextTextTokens } from "../tokenEstimate";

interface CachedBody {
  filePath: string;
  mtimeMs: number;
  result: SkillReadResult;
}

export class SkillBodyStore {
  private readonly bodyCache = new Map<string, CachedBody>();

  async read(skill: SkillMetadata): Promise<SkillReadResult> {
    const fileStat = await stat(skill.filePath);
    const cacheKey = createCacheKey(skill);
    const cached = this.bodyCache.get(cacheKey);
    if (cached && cached.filePath === skill.filePath && cached.mtimeMs === fileStat.mtimeMs) {
      return { ...cached.result, status: SkillReadStatus.Cached };
    }

    const raw = await readFile(skill.filePath, "utf-8");
    const { body } = parseSkillMarkdown(raw);
    assertPromptContributionBudget(
      `skill body: ${skill.name}`,
      body,
      PROMPT_CONTRIBUTION_BUDGETS.skillBody,
    );
    const loaded: LoadedSkill = {
      ...skill,
      body,
      loadedAt: Date.now(),
      tokenEstimate: estimateContextTextTokens(body),
    };
    const result: SkillReadResult = {
      status: SkillReadStatus.Loaded,
      skill: loaded,
      renderedText: renderLoadedSkill(skill, body),
    };
    this.bodyCache.set(cacheKey, { filePath: skill.filePath, mtimeMs: fileStat.mtimeMs, result });
    return result;
  }

  prune(activeSkills: SkillMetadata[]): void {
    const activeKeys = new Set(activeSkills.map(createCacheKey));
    for (const key of this.bodyCache.keys()) {
      if (!activeKeys.has(key)) this.bodyCache.delete(key);
    }
  }
}

function createCacheKey(skill: Pick<SkillMetadata, "name" | "filePath">): string {
  return `${skill.name}\u0000${skill.filePath}`;
}
