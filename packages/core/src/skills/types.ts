import type { SkillReadStatus, SkillSourceScope } from "./constants";

export type SkillSource =
  | { scope: typeof SkillSourceScope.Project; path: string }
  | { scope: typeof SkillSourceScope.User; path: string }
  | { scope: typeof SkillSourceScope.Plugin; pluginId: string; path: string };

export interface SkillMetadata {
  readonly sourceRoot: { readonly path: string; readonly dev: number; readonly ino: number };
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  allowedTools?: string[];
}

export interface LoadedSkill extends SkillMetadata {
  readonly version: string;
  body: string;
  loadedAt: number;
  tokenEstimate: number;
}

export type SkillDiagnostic =
  | { type: "warning"; code: "missing-description"; path: string; message: string }
  | { type: "warning"; code: "missing-body"; path: string; message: string }
  | { type: "warning"; code: "invalid-name"; path: string; message: string }
  | { type: "warning"; code: "collision"; path: string; winnerPath: string; message: string }
  | { type: "error"; code: "read-error" | "parse-error"; path: string; message: string };

export interface SkillLoaderOptions {
  cwd: string;
  includeOmniDirs?: boolean;
  includeAgentsDirs?: boolean;
  pluginSkillDirs?: Array<{ pluginId: string; dir: string }>;
}

export interface SkillLoadResult {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillRegistryOptions {
  cwd: string;
  loader?: { loadAll(): Promise<SkillLoadResult> };
}

export interface SkillReadOptions {
  explicit?: boolean;
}

export interface SkillReadResult {
  readonly diagnostic?: SkillDiagnostic;
  status: typeof SkillReadStatus.Loaded | typeof SkillReadStatus.Cached;
  skill: LoadedSkill;
  renderedText: string;
}

export interface SkillSlashPreload {
  displayInput: string;
  modelInput: string;
  skill: LoadedSkill;
  status: typeof SkillReadStatus.Loaded | typeof SkillReadStatus.Cached;
}
