import { homedir } from "node:os";
import path from "node:path";
import { SKILL_DIR_NAMES, SkillSourceScope } from "./constants";
import type { SkillLoaderOptions, SkillSource } from "./types";

export interface SkillSearchDir {
  dir: string;
  source: SkillSource;
}

export class SkillPathResolver {
  constructor(private readonly options: SkillLoaderOptions) {}

  resolve(): SkillSearchDir[] {
    const dirs: SkillSearchDir[] = [];
    const cwd = path.resolve(this.options.cwd);
    const includeOmniDirs = this.options.includeOmniDirs ?? true;
    const includeAgentsDirs = this.options.includeAgentsDirs ?? true;

    if (includeOmniDirs) {
      dirs.push(projectDir(cwd, SKILL_DIR_NAMES.omni));
    }
    if (includeAgentsDirs) {
      dirs.push(projectDir(cwd, SKILL_DIR_NAMES.agents));
    }
    for (const plugin of this.options.pluginSkillDirs ?? []) {
      dirs.push({
        dir: plugin.dir,
        source: { scope: SkillSourceScope.Plugin, pluginId: plugin.pluginId, path: plugin.dir },
      });
    }
    if (includeOmniDirs) {
      dirs.push(userDir(SKILL_DIR_NAMES.omni));
    }
    if (includeAgentsDirs) {
      dirs.push(userDir(SKILL_DIR_NAMES.agents));
    }

    return dirs;
  }
}

function projectDir(cwd: string, base: string): SkillSearchDir {
  const dir = path.join(cwd, base, SKILL_DIR_NAMES.skills);
  return { dir, source: { scope: SkillSourceScope.Project, path: dir } };
}

function userDir(base: string): SkillSearchDir {
  const dir = path.join(homedir(), base, SKILL_DIR_NAMES.skills);
  return { dir, source: { scope: SkillSourceScope.User, path: dir } };
}
