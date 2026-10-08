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

  /** Validates the complete replacement before mutating the live catalog. */
  replaceOrigin(originId: string, tools: readonly AgentToolDefinition[]): void {
    const replacementNames = new Set<string>();
    for (const tool of tools) {
      this.validate(tool, originId);
      if (replacementNames.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
      const current = this.tools.get(tool.name);
      if (current && current.originId !== originId)
        throw new Error(`Tool already registered: ${tool.name}`);
      replacementNames.add(tool.name);
    }
    for (const [name, current] of this.tools)
      if (current.originId === originId) this.tools.delete(name);
    for (const tool of tools)
      this.tools.set(tool.name, { ...tool, originId, toolIdentity: `${originId}:${tool.name}` });
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
