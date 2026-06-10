import path from "node:path";
import { SkillDiagnosticCode, SkillDiagnosticType, SkillFrontmatterKeys } from "./constants";
import {
  getBooleanField,
  getStringArrayField,
  getStringField,
} from "./frontmatter";
import type { SkillDraft } from "./parser";
import type { SkillDiagnostic, SkillMetadata } from "./types";

export interface SkillValidationResult {
  skill: SkillMetadata | null;
  diagnostics: SkillDiagnostic[];
}

export class SkillValidator {
  validate(draft: SkillDraft): SkillValidationResult {
    const diagnostics: SkillDiagnostic[] = [];
    const name = getStringField(draft.frontmatter, ...SkillFrontmatterKeys.name) ?? draft.fallbackName;
    const description = getStringField(draft.frontmatter, ...SkillFrontmatterKeys.description);

    if (!description || !description.trim()) {
      diagnostics.push({
        type: SkillDiagnosticType.Warning,
        code: SkillDiagnosticCode.MissingDescription,
        path: draft.filePath,
        message: "Skill description is required",
      });
      return { skill: null, diagnostics };
    }

    if (!draft.body.trim()) {
      diagnostics.push({
        type: SkillDiagnosticType.Warning,
        code: SkillDiagnosticCode.MissingBody,
        path: draft.filePath,
        message: "Skill body is empty",
      });
      return { skill: null, diagnostics };
    }

    if (!isValidSkillName(name)) {
      diagnostics.push({
        type: SkillDiagnosticType.Warning,
        code: SkillDiagnosticCode.InvalidName,
        path: draft.filePath,
        message: `Skill name "${name}" must use lowercase letters, numbers, and hyphens`,
      });
      return { skill: null, diagnostics };
    }

    return {
      skill: {
        name,
        description: description.trim(),
        filePath: draft.filePath,
        baseDir: path.dirname(draft.filePath),
        source: draft.source,
        userInvocable: getBooleanField(draft.frontmatter, true, ...SkillFrontmatterKeys.userInvocable),
        disableModelInvocation: getBooleanField(draft.frontmatter, false, ...SkillFrontmatterKeys.disableModelInvocation),
        allowedTools: getStringArrayField(draft.frontmatter, ...SkillFrontmatterKeys.allowedTools),
      },
      diagnostics,
    };
  }
}

function isValidSkillName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) && !name.includes("--");
}
