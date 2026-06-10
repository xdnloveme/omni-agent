import type { SkillMetadata } from "./types";

export function renderSkillPromptIndex(skills: SkillMetadata[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "# Skills",
    "",
    "Skills are progressive context. If the user's task matches a listed skill, call `skill_read` with the exact skill name before acting. Do not assume full instructions from the description alone.",
    "",
    "<available_skills>",
  ];

  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

export function renderLoadedSkill(skill: SkillMetadata, body: string): string {
  return [
    `<skill name="${escapeXml(skill.name)}" source="${escapeXml(skill.source.scope)}">`,
    body,
    "</skill>",
    "",
    "<skill_context>",
    `base_dir: ${skill.baseDir}`,
    "When this skill references relative paths, resolve them against base_dir.",
    "</skill_context>",
  ].join("\n");
}

export function renderExplicitSkillContext(skill: SkillMetadata, body: string): string {
  return [
    `<explicit_skill name="${escapeXml(skill.name)}" source="${escapeXml(skill.source.scope)}">`,
    body,
    "</explicit_skill>",
    "",
    "<explicit_skill_context>",
    `base_dir: ${skill.baseDir}`,
    `The user explicitly invoked this skill with /${skill.name}.`,
    "</explicit_skill_context>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
