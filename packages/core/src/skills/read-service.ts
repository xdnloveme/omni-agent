import { SkillBodyStore } from "./body-store";
import type { SkillMetadata, SkillReadOptions, SkillReadResult } from "./types";

export interface SkillMetadataRepository {
  list(): SkillMetadata[];
  get(name: string): SkillMetadata | undefined;
  acceptRead(previous: SkillMetadata, result: SkillReadResult): void;
}

export class SkillReadService {
  constructor(
    private readonly repository: SkillMetadataRepository,
    private readonly bodyStore: SkillBodyStore,
  ) {}

  async read(name: string, options: SkillReadOptions = {}): Promise<SkillReadResult> {
    const skill = this.repository.get(name);
    if (!skill) {
      throw new Error(
        `Unknown skill "${name}". Available skills: ${
          this.repository
            .list()
            .map((s) => s.name)
            .join(", ") || "none"
        }`,
      );
    }
    const result = await this.bodyStore.read(skill);
    this.repository.acceptRead(skill, result);
    if (result.skill.name !== name)
      throw new Error('Skill was renamed to "' + result.skill.name + '"; invoke its current name.');
    if (result.skill.disableModelInvocation && !options.explicit) {
      throw new Error(`Skill "${name}" is disabled for model invocation`);
    }
    if (options.explicit && !result.skill.userInvocable) {
      throw new Error(`Skill "${name}" is not user-invocable`);
    }
    return result;
  }
}
