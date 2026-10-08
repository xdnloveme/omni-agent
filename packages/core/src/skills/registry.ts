import { SkillBodyStore } from "./body-store";
import { cloneData } from "../dataCopy";
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
  private initialized = false;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: SkillRegistryOptions) {
    this.loader = options.loader ?? new SkillLoader({ cwd: options.cwd });
    this.bodyStore = new SkillBodyStore();
    this.readService = new SkillReadService(this, this.bodyStore);
    this.slashPreloader = new SkillSlashPreloader(this, this.readService);
  }

  async initialize(): Promise<SkillLoadResult> {
    return this.reload();
  }

  reload(): Promise<SkillLoadResult> {
    return this.serialize(() => this.loadCatalog());
  }

  private async loadCatalog(): Promise<SkillLoadResult> {
    const result = await this.loader.loadAll();
    for (const skill of result.skills) {
      const previous = this.skills.find((entry) => entry.source.path === skill.source.path);
      if (
        previous &&
        (previous.sourceRoot.path !== skill.sourceRoot.path ||
          previous.sourceRoot.dev !== skill.sourceRoot.dev ||
          previous.sourceRoot.ino !== skill.sourceRoot.ino)
      )
        result.diagnostics.push({
          type: "error",
          code: "read-error",
          path: skill.filePath,
          message: "Skill source root changed; refusing to replace its trusted boundary.",
        });
    }
    if (
      this.initialized &&
      result.diagnostics.some(
        (diagnostic) => diagnostic.type === "error" || diagnostic.code !== "collision",
      )
    ) {
      this.skillDiagnostics = result.diagnostics;
      return { skills: this.list(), diagnostics: this.diagnostics() };
    }
    this.skills = cloneData(result.skills);
    this.skillDiagnostics = result.diagnostics;
    this.bodyStore.prune(this.skills);
    this.initialized = true;
    return result;
  }

  list(): SkillMetadata[] {
    return cloneData(this.skills);
  }

  get(name: string): SkillMetadata | undefined {
    return cloneData(this.skills.find((skill) => skill.name === name));
  }

  diagnostics(): SkillDiagnostic[] {
    return [...this.skillDiagnostics];
  }

  renderPromptIndex(): string {
    return renderSkillPromptIndex(this.skills);
  }

  read(name: string, options: SkillReadOptions = {}): Promise<SkillReadResult> {
    return this.serialize(async () => {
      if (!this.get(name)) await this.loadCatalog();
      return this.readService.read(name, options);
    });
  }

  resolveSlashPreload(input: string): Promise<SkillSlashPreload | null> {
    return this.serialize(() => this.slashPreloader.resolve(input));
  }

  acceptRead(previous: SkillMetadata, result: SkillReadResult): void {
    const {
      body: _body,
      loadedAt: _loadedAt,
      tokenEstimate: _tokens,
      version: _version,
      ...metadata
    } = result.skill;
    if (this.skills.some((entry) => entry.name === metadata.name && entry.name !== previous.name))
      throw new Error("Skill name collision after update: " + metadata.name);
    this.skills = this.skills.map((entry) =>
      entry.name === previous.name ? cloneData(metadata) : entry,
    );
    this.skillDiagnostics = this.skillDiagnostics.filter(
      (entry) => entry.path !== previous.filePath,
    );
    if (result.diagnostic) this.skillDiagnostics.push(result.diagnostic);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.pending.then(operation);
    this.pending = pending.catch(() => undefined);
    return pending;
  }
}
