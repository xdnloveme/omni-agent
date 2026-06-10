import { SkillDiagnosticCode, SkillDiagnosticType } from "./constants";
import type { SkillDiagnostic, SkillMetadata } from "./types";

export interface SkillCatalogMergeResult {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
}

export class SkillCatalogMerger {
  merge(skills: SkillMetadata[]): SkillCatalogMergeResult {
    const byName = new Map<string, SkillMetadata>();
    const diagnostics: SkillDiagnostic[] = [];

    for (const skill of skills) {
      const existing = byName.get(skill.name);
      if (existing) {
        diagnostics.push({
          type: SkillDiagnosticType.Warning,
          code: SkillDiagnosticCode.Collision,
          path: skill.filePath,
          winnerPath: existing.filePath,
          message: `Skill "${skill.name}" is hidden by higher-priority skill at ${existing.filePath}`,
        });
        continue;
      }
      byName.set(skill.name, skill);
    }

    return { skills: [...byName.values()], diagnostics };
  }
}
