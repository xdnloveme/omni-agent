import { SkillBodyStore } from "./body-store";
import { SkillLoader } from "./loader";
import { renderSkillPromptIndex } from "./prompt";
import { SkillReadService } from "./read-service";
import { SkillSlashPreloader } from "./slash-preloader";
import type {
  SkillDiagnostic,
  SkillLoadResult,
  SkillMetadata,
  SkillReadOptions,
  SkillReadResult,
  SkillRegistryOptions,
  SkillSlashPreload,
} from "./types";

export class SkillRegistry {
  private readonly loader: { loadAll(): Promise<SkillLoadResult> };
  private readonly bodyStore: SkillBodyStore;
  private readonly readService: SkillReadService;
  private readonly slashPreloader: SkillSlashPreloader;
  private skills: SkillMetadata[] = [];
  private skillDiagnostics: SkillDiagnostic[] = [];

  constructor(options: SkillRegistryOptions) {
    this.loader = options.loader ?? new SkillLoader({ cwd: options.cwd });
    this.bodyStore = new SkillBodyStore();
    this.readService = new SkillReadService(this, this.bodyStore);
    this.slashPreloader = new SkillSlashPreloader(this, this.readService);
  }

  async initialize(): Promise<SkillLoadResult> {
    return this.reload();
  }

  async reload(): Promise<SkillLoadResult> {
    const result = await this.loader.loadAll();
    this.skills = result.skills;
    this.skillDiagnostics = result.diagnostics;
    this.bodyStore.prune(this.skills);
    return result;
  }

  list(): SkillMetadata[] {
    return [...this.skills];
  }

  get(name: string): SkillMetadata | undefined {
    return this.skills.find((skill) => skill.name === name);
  }

  diagnostics(): SkillDiagnostic[] {
    return [...this.skillDiagnostics];
  }

  renderPromptIndex(): string {
    return renderSkillPromptIndex(this.skills);
  }

  read(name: string, options: SkillReadOptions = {}): Promise<SkillReadResult> {
    return this.readService.read(name, options);
  }

  resolveSlashPreload(input: string): Promise<SkillSlashPreload | null> {
    return this.slashPreloader.resolve(input);
  }
}
