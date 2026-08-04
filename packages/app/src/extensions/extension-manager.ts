import { CommandRegistry } from "@omni-agent/core";
import { AgentRegistry } from "../registry/agent-registry";
import { ToolRegistry } from "../registry/tool-registry";
import type { AgentExtension, ExtensionDiagnostic } from "./types";

export interface ExtensionManagerOptions {
  cwd: string;
  agents?: AgentRegistry;
  tools?: ToolRegistry;
  commands?: CommandRegistry;
}

export class ExtensionManager {
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  readonly commands: CommandRegistry;
  readonly diagnostics: ExtensionDiagnostic[] = [];
  private readonly cwd: string;
  private readonly active = new Map<string, AgentExtension>();

  constructor(options: ExtensionManagerOptions) {
    this.cwd = options.cwd;
    this.agents = options.agents ?? new AgentRegistry();
    this.tools = options.tools ?? new ToolRegistry();
    this.commands = options.commands ?? new CommandRegistry();
  }

  async register(extension: AgentExtension): Promise<void> {
    this.validate(extension);
    const registeredAgents: string[] = [];
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];
    try {
      for (const tool of extension.contributions.tools ?? []) {
        this.tools.register(tool);
        registeredTools.push(tool.name);
      }
      for (const agent of extension.contributions.agents ?? []) {
        this.agents.register(agent);
        registeredAgents.push(agent.definition.id);
      }
      for (const command of extension.contributions.commands ?? []) {
        this.commands.register(command);
        registeredCommands.push(command.name);
      }
      await extension.activate?.({ cwd: this.cwd });
      this.active.set(extension.manifest.id, extension);
    } catch (error) {
      for (const id of registeredAgents) this.agents.unregister(id);
      for (const name of registeredTools) this.tools.unregister(name);
      for (const name of registeredCommands) this.commands.unregister(name);
      throw error;
    }
  }

  async registerOptional(extension: AgentExtension, source: string): Promise<void> {
    try {
      await this.register(extension);
    } catch (error) {
      this.diagnostics.push({
        extensionId: extension.manifest.id,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  list(): AgentExtension[] {
    return [...this.active.values()];
  }

  async dispose(): Promise<void> {
    for (const extension of [...this.active.values()].reverse()) {
      await extension.dispose?.();
    }
    this.active.clear();
  }

  private validate(extension: AgentExtension): void {
    const { id, version, apiVersion } = extension.manifest;
    if (!id.trim()) throw new Error("Extension id is required");
    if (!version.trim()) throw new Error(`Extension version is required: ${id}`);
    if (apiVersion !== 1) throw new Error(`Unsupported extension API version: ${apiVersion}`);
    if (this.active.has(id)) throw new Error(`Extension already registered: ${id}`);

    const toolNames = new Set<string>();
    for (const tool of extension.contributions.tools ?? []) {
      if (toolNames.has(tool.name) || this.tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      toolNames.add(tool.name);
    }
    const agentIds = new Set<string>();
    const availableToolNames = new Set([
      ...this.tools.list().map((tool) => tool.name),
      ...toolNames,
    ]);
    for (const agent of extension.contributions.agents ?? []) {
      const agentId = agent.definition.id;
      if (agentIds.has(agentId) || this.agents.has(agentId)) {
        throw new Error(`Agent already registered: ${agentId}`);
      }
      if (agent.tools.include !== "*") {
        for (const toolName of agent.tools.include) {
          if (!availableToolNames.has(toolName)) {
            throw new Error(`Agent ${agentId} references unknown tool: ${toolName}`);
          }
        }
      }
      agentIds.add(agentId);
    }
    const commandNames = new Set<string>();
    for (const command of extension.contributions.commands ?? []) {
      if (commandNames.has(command.name) || this.commands.has(command.name)) {
        throw new Error(`Command already registered: ${command.name}`);
      }
      commandNames.add(command.name);
    }
  }
}
