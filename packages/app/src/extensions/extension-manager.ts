import { CommandRegistry, isToolOriginId } from "@omni-agent/core";
import { AgentRegistry } from "../registry/agent-registry";
import { ToolRegistry } from "../registry/tool-registry";
import type { AgentExtension, ExtensionDiagnostic } from "./types";
import type { VendorPluginManager } from "@omni-agent/models";
import type { RuntimeMiddleware } from "@omni-agent/core";

export interface ExtensionManagerOptions {
  cwd: string;
  agents?: AgentRegistry;
  tools?: ToolRegistry;
  commands?: CommandRegistry;
  modelProviders?: VendorPluginManager;
}

export class ExtensionManager {
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  readonly commands: CommandRegistry;
  readonly middleware: RuntimeMiddleware[] = [];
  readonly diagnostics: ExtensionDiagnostic[] = [];
  private readonly cwd: string;
  private readonly active = new Map<
    string,
    {
      extension: AgentExtension;
      agents: string[];
      tools: string[];
      commands: string[];
      providers: string[];
      middleware: RuntimeMiddleware[];
    }
  >();
  private readonly modelProviders?: VendorPluginManager;

  constructor(options: ExtensionManagerOptions) {
    this.cwd = options.cwd;
    this.agents = options.agents ?? new AgentRegistry();
    this.tools = options.tools ?? new ToolRegistry();
    this.commands = options.commands ?? new CommandRegistry();
    this.modelProviders = options.modelProviders;
  }

  async register(extension: AgentExtension, originId = extension.manifest.id): Promise<void> {
    this.validate(extension, originId);
    const registeredAgents: string[] = [];
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];
    const registeredProviders: string[] = [];
    const registeredMiddleware: RuntimeMiddleware[] = [];
    try {
      for (const provider of extension.contributions.providers ?? []) {
        if (!this.modelProviders) throw new Error("Model provider contributions are not enabled");
        await this.modelProviders.register(provider);
        registeredProviders.push(provider.manifest.id);
      }
      for (const tool of extension.contributions.tools ?? []) {
        this.tools.register(tool, originId);
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
      for (const middleware of extension.contributions.middleware ?? []) {
        this.middleware.push(middleware);
        registeredMiddleware.push(middleware);
      }
      await extension.activate?.({ cwd: this.cwd });
      this.active.set(extension.manifest.id, {
        extension,
        agents: registeredAgents,
        tools: registeredTools,
        commands: registeredCommands,
        providers: registeredProviders,
        middleware: registeredMiddleware,
      });
    } catch (error) {
      this.removeMiddleware([...registeredMiddleware].reverse());
      for (const name of [...registeredCommands].reverse()) this.commands.unregister(name);
      for (const id of [...registeredAgents].reverse()) this.agents.unregister(id);
      for (const name of [...registeredTools].reverse()) this.tools.unregister(name);
      for (const id of registeredProviders.reverse()) await this.modelProviders?.unregister(id);
      await this.disposeExtension(extension, "activation-rollback");
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
    return [...this.active.values()].map((entry) => entry.extension);
  }

  async unregister(extensionId: string): Promise<void> {
    const entry = this.active.get(extensionId);
    if (!entry) return;
    this.removeMiddleware([...entry.middleware].reverse());
    for (const name of [...entry.commands].reverse()) this.commands.unregister(name);
    for (const id of [...entry.agents].reverse()) this.agents.unregister(id);
    for (const name of [...entry.tools].reverse()) this.tools.unregister(name);
    for (const id of [...entry.providers].reverse()) await this.modelProviders?.unregister(id);
    this.active.delete(extensionId);
    await this.disposeExtension(entry.extension, "unregister");
  }

  async dispose(): Promise<void> {
    for (const extensionId of [...this.active.keys()].reverse()) await this.unregister(extensionId);
  }

  private validate(extension: AgentExtension, originId: string): void {
    const { id, version, apiVersion } = extension.manifest;
    if (!isToolOriginId(id)) {
      throw new Error(`Invalid extension id: ${id}`);
    }
    if (!version.trim()) throw new Error(`Extension version is required: ${id}`);
    if (apiVersion !== 1) throw new Error(`Unsupported extension API version: ${apiVersion}`);
    if (this.active.has(id)) throw new Error(`Extension already registered: ${id}`);

    const toolNames = new Set<string>();
    for (const tool of extension.contributions.tools ?? []) {
      this.tools.validate(tool, originId);
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
    const providerPluginIds = new Set<string>();
    for (const provider of extension.contributions.providers ?? []) {
      if (providerPluginIds.has(provider.manifest.id)) {
        throw new Error(`Provider plugin duplicated in extension: ${provider.manifest.id}`);
      }
      providerPluginIds.add(provider.manifest.id);
    }
  }

  private removeMiddleware(entries: readonly RuntimeMiddleware[]): void {
    for (const middleware of entries) {
      const index = this.middleware.lastIndexOf(middleware);
      if (index >= 0) this.middleware.splice(index, 1);
    }
  }

  private async disposeExtension(extension: AgentExtension, source: string): Promise<void> {
    try {
      await extension.dispose?.();
    } catch (error) {
      this.diagnostics.push({
        extensionId: extension.manifest.id,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
