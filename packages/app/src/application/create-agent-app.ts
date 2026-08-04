import type { AgentConfig } from "@omni-agent/core";
import { AgentApplication } from "./agent-application";
import { ExtensionManager } from "../extensions/extension-manager";
import { loadLocalAgentExtensions } from "../extensions/local-extension-loader";
import type { AgentExtension } from "../extensions/types";
import { SessionService } from "../sessions/session-service";

export interface AgentRuntimeSettings {
  model: string;
  apiKey: string;
  endpoint?: string;
  provider?: AgentConfig["provider"];
  maxTurns?: number;
  maxTokens?: number;
  contextWindow?: number;
}

export interface CreateAgentAppOptions {
  runtime: AgentRuntimeSettings;
  extensions: AgentExtension[];
  defaultAgentId: string;
  cwd?: string;
  loadLocalExtensions?: boolean;
  sessions?: SessionService;
}

export async function createAgentApp(options: CreateAgentAppOptions): Promise<AgentApplication> {
  const cwd = options.cwd ?? process.cwd();
  const manager = new ExtensionManager({ cwd });
  for (const extension of options.extensions) await manager.register(extension);

  if (options.loadLocalExtensions !== false) {
    const local = await loadLocalAgentExtensions(cwd);
    manager.diagnostics.push(...local.diagnostics);
    for (const entry of local.extensions) {
      await manager.registerOptional(entry.extension, entry.source);
    }
  }

  const contribution = manager.agents.get(options.defaultAgentId);
  if (!contribution) throw new Error(`Default agent not found: ${options.defaultAgentId}`);
  const instructions = contribution.definition.instructions;
  const systemPrompt = typeof instructions === "function"
    ? await instructions({ cwd })
    : instructions;
  const tools = manager.tools.resolve(contribution.tools);
  const model = contribution.definition.model;
  const agentConfig: AgentConfig = {
    model: model?.model ?? options.runtime.model,
    apiKey: options.runtime.apiKey,
    endpoint: model?.endpoint ?? options.runtime.endpoint,
    provider: model?.provider ?? options.runtime.provider,
    systemPrompt,
    tools,
    maxTurns: contribution.definition.maxTurns ?? options.runtime.maxTurns,
    maxTokens: model?.maxTokens ?? options.runtime.maxTokens,
    contextWindow: model?.contextWindow ?? options.runtime.contextWindow,
  };
  const sessions = options.sessions ?? new SessionService();
  sessions.restoreLatest();
  return new AgentApplication(manager, sessions, agentConfig, options.defaultAgentId, cwd);
}
