import {
  ToolDefinitionValidator,
  ToolInputValidator,
  isToolOriginId,
  type AgentToolDefinition,
  type RegisteredAgentTool,
} from "@omni-agent/core";
import type { ToolExposure } from "../extensions/types";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredAgentTool>();
  private readonly validator: ToolDefinitionValidator;

  constructor(inputValidator = new ToolInputValidator()) {
    this.validator = new ToolDefinitionValidator(inputValidator);
  }

  validate(tool: AgentToolDefinition, originId: string): void {
    this.validator.validate(tool);
    if (!isToolOriginId(originId)) {
      throw new Error(`Invalid tool origin: ${originId}`);
    }
  }

  register(tool: AgentToolDefinition, originId: string): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.validate(tool, originId);
    this.tools.set(tool.name, {
      ...tool,
      originId,
      toolIdentity: `${originId}:${tool.name}`,
    });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): RegisteredAgentTool[] {
    return [...this.tools.values()];
  }

  resolve(exposure: ToolExposure): RegisteredAgentTool[] {
    const excluded = new Set(exposure.exclude ?? []);
    if (exposure.include === "*") {
      return this.list().filter((tool) => !excluded.has(tool.name));
    }
    return exposure.include
      .filter((name) => !excluded.has(name))
      .map((name) => {
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`Agent references unknown tool: ${name}`);
        return tool;
      });
  }
}
