import { SkillBodyStore } from "./body-store";
import type { SkillMetadata, SkillReadOptions, SkillReadResult } from "./types";

export interface SkillMetadataRepository {
  list(): SkillMetadata[];
  get(name: string): SkillMetadata | undefined;
}

export class SkillReadService {
  constructor(
    private readonly repository: SkillMetadataRepository,
    private readonly bodyStore: SkillBodyStore,
  ) {}

  async read(name: string, options: SkillReadOptions = {}): Promise<SkillReadResult> {
    const skill = this.repository.get(name);
    if (!skill) {
      throw new Error(`Unknown skill "${name}". Available skills: ${this.repository.list().map((s) => s.name).join(", ") || "none"}`);
    }
    if (skill.disableModelInvocation && !options.explicit) {
      throw new Error(`Skill "${name}" is disabled for model invocation`);
    }
    if (options.explicit && !skill.userInvocable) {
      throw new Error(`Skill "${name}" is not user-invocable`);
    }
    return this.bodyStore.read(skill);
  }
}
