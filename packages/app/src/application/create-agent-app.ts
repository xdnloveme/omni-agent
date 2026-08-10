import type { AgentConfig } from "@omni-agent/core";
import { AgentApplication } from "./agent-application";
import { ExtensionManager } from "../extensions/extension-manager";
import { loadLocalAgentExtensions } from "../extensions/local-extension-loader";
import type { AgentExtension } from "../extensions/types";
import { SessionService } from "../sessions/session-service";
import {
  createModelService,
  type ModelSelection,
  type ModelService,
} from "../models/model-service";

export interface CreateAgentAppOptions {
  modelSelection: ModelSelection;
  modelService?: ModelService;
  persistModelSelection?: (selection: ModelSelection) => void | Promise<void>;
  extensions: AgentExtension[];
  defaultAgentId: string;
  cwd?: string;
  loadLocalExtensions?: boolean;
  sessions?: SessionService;
}

export async function createAgentApp(options: CreateAgentAppOptions): Promise<AgentApplication> {
  const cwd = options.cwd ?? process.cwd();
  const ownsModelService = !options.modelService;
  const modelService = options.modelService ?? (await createModelService({ cwd }));
  const manager = new ExtensionManager({ cwd, modelProviders: modelService.providerPlugins });
  try {
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
    const systemPrompt =
      typeof instructions === "function" ? await instructions({ cwd }) : instructions;
    const tools = manager.tools.resolve(contribution.tools);
    const resolvedModel = await modelService.resolve(options.modelSelection);
    if (!(await modelService.isConfigured(resolvedModel.providerId))) {
      throw new Error(`Provider is not configured: ${resolvedModel.providerId}`);
    }
    const agentConfig: AgentConfig = {
      model: resolvedModel,
      systemPrompt,
      tools,
      middleware: manager.middleware,
      maxTurns: contribution.definition.maxTurns,
    };
    const sessions = options.sessions ?? new SessionService();
    sessions.restoreLatest();
    return new AgentApplication({
      extensions: manager,
      sessions,
      agentConfig,
      agentId: options.defaultAgentId,
      cwd,
      modelService,
      modelSelection: options.modelSelection,
      persistModelSelection: options.persistModelSelection,
      ownsModelService,
    });
  } catch (error) {
    try {
      await manager.dispose();
    } finally {
      if (ownsModelService) await modelService.dispose();
    }
    throw error;
  }
}
