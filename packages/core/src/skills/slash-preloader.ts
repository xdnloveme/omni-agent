import { renderExplicitSkillContext } from "./prompt";
import type { SkillSlashPreload } from "./types";
import type { SkillMetadataRepository, SkillReadService } from "./read-service";

export class SkillSlashPreloader {
  constructor(
    private readonly repository: SkillMetadataRepository,
    private readonly readService: SkillReadService,
  ) {}

  async resolve(input: string): Promise<SkillSlashPreload | null> {
    const match = input.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    const skillName = match[1] as string;
    const request = (match[2] ?? "").trim();
    const skill = this.repository.get(skillName);
    if (!skill || !skill.userInvocable) return null;

    const result = await this.readService.read(skillName, { explicit: true });
    const explicitContext = renderExplicitSkillContext(result.skill, result.skill.body);
    return {
      displayInput: input,
      modelInput: `${explicitContext}\n\nUser request:\n${request || `(No additional request provided after /${skillName}.)`}`,
      skill: result.skill,
      status: result.status,
    };
  }
}
