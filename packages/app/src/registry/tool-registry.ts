import type { AgentTool } from "@omni-agent/core";
import type { ToolExposure } from "../extensions/types";

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  resolve(exposure: ToolExposure): AgentTool[] {
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
