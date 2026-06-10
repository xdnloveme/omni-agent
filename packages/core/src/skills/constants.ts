export const SKILL_FILE_NAME = "SKILL.md";
export const SKILL_TOOL_NAME = "skill_read";

export const SkillEventNamespace = {
  Skill: "skill",
} as const;

export const SkillEventName = {
  ReadStart: "read_start",
  ReadEnd: "read_end",
} as const;

export const SKILL_DIR_NAMES = {
  agents: ".agents",
  omni: ".omni-agent",
  skills: "skills",
  nodeModules: "node_modules",
} as const;

export const SkillReadStatus = {
  Loaded: "loaded",
  Cached: "cached",
  Failed: "failed",
} as const;

export type SkillReadStatus = typeof SkillReadStatus[keyof typeof SkillReadStatus];

export const SkillSourceScope = {
  Project: "project",
  User: "user",
  Plugin: "plugin",
} as const;

export type SkillSourceScope = typeof SkillSourceScope[keyof typeof SkillSourceScope];

export const SkillDiagnosticType = {
  Warning: "warning",
  Error: "error",
} as const;

export const SkillDiagnosticCode = {
  MissingDescription: "missing-description",
  MissingBody: "missing-body",
  InvalidName: "invalid-name",
  Collision: "collision",
  ReadError: "read-error",
  ParseError: "parse-error",
} as const;

export const SkillFrontmatterKeys = {
  name: ["name"],
  description: ["description"],
  userInvocable: ["user-invocable", "user_invocable"],
  disableModelInvocation: ["disable-model-invocation", "disable_model_invocation"],
  allowedTools: ["allowed-tools", "allowed_tools"],
} as const;
