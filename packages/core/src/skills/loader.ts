import { SkillDiagnosticCode, SkillDiagnosticType } from "./constants";
import { SkillCatalogMerger } from "./catalog-merger";
import { SkillFileDiscoverer } from "./file-discoverer";
import { SkillParser } from "./parser";
import { SkillPathResolver } from "./path-resolver";
import { SkillValidator } from "./validator";
import type { SkillDiagnostic, SkillLoadResult, SkillLoaderOptions, SkillMetadata } from "./types";

export class SkillLoader {
  private readonly pathResolver: SkillPathResolver;
  private readonly discoverer: SkillFileDiscoverer;
  private readonly parser: SkillParser;
  private readonly validator: SkillValidator;
  private readonly merger: SkillCatalogMerger;

  constructor(options: SkillLoaderOptions) {
    this.pathResolver = new SkillPathResolver(options);
    this.discoverer = new SkillFileDiscoverer();
    this.parser = new SkillParser();
    this.validator = new SkillValidator();
    this.merger = new SkillCatalogMerger();
  }

  async loadAll(): Promise<SkillLoadResult> {
    const diagnostics: SkillDiagnostic[] = [];
    const parsedSkills: SkillMetadata[] = [];

    for (const entry of this.pathResolver.resolve()) {
      const candidates = await this.discoverer.discover(entry.dir, entry.source);
      for (const candidate of candidates) {
        try {
          const draft = await this.parser.parse(
            candidate.filePath,
            candidate.fallbackName,
            candidate.source,
          );
          const validated = this.validator.validate(draft);
          diagnostics.push(...validated.diagnostics);
          if (validated.skill) parsedSkills.push(validated.skill);
        } catch (err) {
          diagnostics.push({
            type: SkillDiagnosticType.Error,
            code: SkillDiagnosticCode.ReadError,
            path: candidate.filePath,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const merged = this.merger.merge(parsedSkills);
    return {
      skills: merged.skills,
      diagnostics: [...diagnostics, ...merged.diagnostics],
    };
  }
}
