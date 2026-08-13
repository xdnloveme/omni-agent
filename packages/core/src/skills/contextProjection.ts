import { SkillProjectionStrategy, type MicroProjectionStrategyPort } from "../context";
import { SKILL_TOOL_NAME } from "./constants";

export function createSkillContextProjectionStrategies(): readonly MicroProjectionStrategyPort[] {
  return [
    new SkillProjectionStrategy({
      resultKind: SKILL_TOOL_NAME,
      toolName: SKILL_TOOL_NAME,
    }),
  ];
}
