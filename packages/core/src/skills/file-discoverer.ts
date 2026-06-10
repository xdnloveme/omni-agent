import { readdir } from "node:fs/promises";
import path from "node:path";
import { SKILL_DIR_NAMES, SKILL_FILE_NAME } from "./constants";
import type { SkillSource } from "./types";

export interface SkillFileCandidate {
  filePath: string;
  fallbackName: string;
  source: SkillSource;
}

export class SkillFileDiscoverer {
  async discover(dir: string, source: SkillSource): Promise<SkillFileCandidate[]> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const candidates: SkillFileCandidate[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === SKILL_DIR_NAMES.nodeModules) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        candidates.push({
          filePath: path.join(fullPath, SKILL_FILE_NAME),
          fallbackName: entry.name,
          source,
        });
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        candidates.push({
          filePath: fullPath,
          fallbackName: path.basename(entry.name, ".md"),
          source,
        });
      }
    }

    return candidates;
  }
}
