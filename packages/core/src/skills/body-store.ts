import { renderLoadedSkill } from "./prompt";
import type { LoadedSkill, SkillMetadata, SkillReadResult } from "./types";
import { SkillReadStatus } from "./constants";
import { SkillParser } from "./parser";
import { SkillValidator } from "./validator";
import { assertPromptContributionBudget, PROMPT_CONTRIBUTION_BUDGETS } from "../promptBudget";
import { estimateContextTextTokens } from "../tokenEstimate";
import { cloneData } from "../dataCopy";

export class SkillBodyStore {
  private readonly bodyCache = new Map<string, SkillReadResult>();
  private readonly parser = new SkillParser();
  private readonly validator = new SkillValidator();

  async read(skill: SkillMetadata): Promise<SkillReadResult> {
    const cacheKey = createCacheKey(skill);
    const cached = this.bodyCache.get(cacheKey);
    try {
      const draft = await this.parser.parse(skill.filePath, skill.name, skill.source, {
        fullBody: true,
        sourceRoot: skill.sourceRoot,
      });
      if (cached?.skill.version === draft.version)
        return cloneData({ ...cached, status: SkillReadStatus.Cached });
      const validated = this.validator.validate(draft);
      if (!validated.skill || validated.diagnostics.length)
        throw new Error(
          validated.diagnostics.map((entry) => entry.message).join("; ") || "Invalid Skill",
        );
      assertPromptContributionBudget(
        "skill body: " + validated.skill.name,
        draft.body,
        PROMPT_CONTRIBUTION_BUDGETS.skillBody,
      );
      const loaded: LoadedSkill = {
        ...validated.skill,
        version: draft.version,
        body: draft.body,
        loadedAt: Date.now(),
        tokenEstimate: estimateContextTextTokens(draft.body),
      };
      const result: SkillReadResult = {
        status: SkillReadStatus.Loaded,
        skill: loaded,
        renderedText: renderLoadedSkill(loaded, draft.body),
      };
      this.bodyCache.set(cacheKey, result);
      return cloneData(result);
    } catch (error) {
      if (!cached) throw error;
      // An invalid update cannot replace a previously validated body or its invocation policy.
      const diagnostic = {
        type: "error" as const,
        code: "read-error" as const,
        path: skill.filePath,
        message:
          "Skill update rejected; using the last validated version. " +
          (error instanceof Error ? error.message : String(error)),
      };
      return cloneData({
        ...cached,
        status: SkillReadStatus.Cached,
        diagnostic,
        renderedText: cached.renderedText + "\n\nSkill update diagnostic: " + diagnostic.message,
      });
    }
  }

  prune(activeSkills: SkillMetadata[]): void {
    const activeKeys = new Set(activeSkills.map(createCacheKey));
    for (const key of this.bodyCache.keys()) if (!activeKeys.has(key)) this.bodyCache.delete(key);
  }
}

function createCacheKey(skill: SkillMetadata): string {
  return [skill.filePath, skill.sourceRoot.path, skill.sourceRoot.dev, skill.sourceRoot.ino].join(
    "\u0000",
  );
}
