import type { AgentToolDefinition, ToolResult } from "../types";
import { SKILL_TOOL_NAME, SkillReadStatus } from "./constants";
import type { SkillRegistry } from "./registry";

export function createSkillReadTool(registry: SkillRegistry): AgentToolDefinition {
  return {
    name: SKILL_TOOL_NAME,
    access: { kind: "internal" },
    execution: { kind: "in_process" },
    timeout: { kind: "none" },
    context: { retention: "conversation" },
    description:
      "Read the full instructions for a named skill. Use this when the user's task matches an available skill. The result is added to context for the next step.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "The exact skill name from the available_skills list",
        },
      },
      required: ["name"],
    },
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) {
        return {
          content: [{ type: "text", text: "Error: name is required" }],
          isError: true,
          meta: {
            kind: SKILL_TOOL_NAME,
            skillName: "",
            status: SkillReadStatus.Failed,
            error: "name is required",
          },
        };
      }

      try {
        const result = await registry.read(name);
        return {
          content: [{ type: "text", text: result.renderedText }],
          isError: false,
          meta: {
            kind: SKILL_TOOL_NAME,
            skillName: result.skill.name,
            status: result.status,
            source: result.skill.source,
            filePath: result.skill.filePath,
            tokenEstimate: result.skill.tokenEstimate,
          },
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error reading skill: ${error}` }],
          isError: true,
          meta: { kind: SKILL_TOOL_NAME, skillName: name, status: SkillReadStatus.Failed, error },
        };
      }
    },
  };
}
