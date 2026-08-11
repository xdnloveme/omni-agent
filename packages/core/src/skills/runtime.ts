import type { AgentToolDefinition } from "../types";
import { createSkillReadTool } from "./skill-read-tool";
import { SkillReadLifecycleAdapter } from "./lifecycle-adapter";
import { SkillRegistry } from "./registry";
import type { SkillSlashPreload } from "./types";

export interface SkillRuntimeOptions {
  cwd: string;
}

export class SkillRuntime {
  readonly registry: SkillRegistry;
  private readonly skillReadTool: AgentToolDefinition;
  private readonly lifecycleAdapter: SkillReadLifecycleAdapter;

  constructor(options: SkillRuntimeOptions) {
    this.registry = new SkillRegistry({ cwd: options.cwd });
    this.skillReadTool = createSkillReadTool(this.registry);
    this.lifecycleAdapter = new SkillReadLifecycleAdapter();
  }

  async initialize(): Promise<void> {
    await this.registry.initialize();
  }

  tool(): AgentToolDefinition {
    return this.skillReadTool;
  }

  resolveSlashPreload(input: string): Promise<SkillSlashPreload | null> {
    return this.registry.resolveSlashPreload(input);
  }

  lifecycleAdapters(): SkillReadLifecycleAdapter[] {
    return [this.lifecycleAdapter];
  }

  async reload(): Promise<void> {
    await this.registry.reload();
  }
}
