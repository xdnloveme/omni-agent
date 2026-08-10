import {
  AgentRunner,
  createUserMessage,
  createStreamSession,
  type AgentConfig,
  type AgentEvent,
  type StreamCallbacks,
} from "@omni-agent/core";
import type { AgentSessionRepository } from "@omni-agent/core";
import { ConfigService } from "../config/config-service";
import { ExtensionManager } from "../extensions/extension-manager";
import { ModelService, type ModelSelection } from "../models/model-service";

export class AgentApplication {
  readonly runner: AgentRunner;
  readonly extensions: ExtensionManager;
  readonly sessions: AgentSessionRepository;
  readonly agentConfig: AgentConfig;
  readonly agentId: string;
  readonly cwd: string;
  readonly modelService: ModelService;
  private activeSelection: ModelSelection;
  private readonly configService: ConfigService;

  constructor(dependencies: AgentApplicationDependencies) {
    this.extensions = dependencies.extensions;
    this.sessions = dependencies.sessions;
    this.agentConfig = dependencies.agentConfig;
    this.agentId = dependencies.agentId;
    this.cwd = dependencies.cwd;
    this.modelService = dependencies.modelService;
    this.activeSelection = dependencies.modelSelection;
    this.configService = dependencies.configService;
    this.runner = new AgentRunner(dependencies.modelService.runtime);
  }

  async run(input: string, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.sessions.append(sessionId, [createUserMessage(input)]);
    const streamSession = createStreamSession(callbacks);
    const events = this.runner.run(this.agentConfig, this.sessions.messages, signal, {
      session: streamSession,
    });
    for await (const event of events) {
      await this.persistProduced(event);
    }
  }

  async newSession(): Promise<string> {
    return (await this.sessions.create()).id;
  }

  async clearSession(): Promise<void> {
    await this.sessions.clear(this.requireSessionId());
  }

  async refreshInstructions(): Promise<void> {
    const contribution = this.extensions.agents.get(this.agentId);
    if (!contribution) throw new Error(`Agent not found: ${this.agentId}`);
    const instructions = contribution.definition.instructions;
    this.agentConfig.systemPrompt =
      typeof instructions === "function" ? await instructions({ cwd: this.cwd }) : instructions;
  }

  async setAgentModel(selection: ModelSelection): Promise<void> {
    const next = await this.modelService.resolve(selection);
    const auth = await this.modelService.isConfigured(next.providerId);
    if (!auth) throw new Error(`Provider is not configured: ${next.providerId}`);
    await this.configService.saveAgentModel(this.agentId, selection);
    this.activateModel(selection, next);
  }

  async setSharedModel(selection: ModelSelection): Promise<void> {
    const shared = await this.modelService.resolve(selection);
    if (!(await this.modelService.isConfigured(shared.providerId))) {
      throw new Error(`Provider is not configured: ${shared.providerId}`);
    }
    await this.configService.saveSharedModel(selection);
    const effective = await this.configService.resolveModel(this.agentId);
    if (!effective) throw new Error(`Model is not configured for agent: ${this.agentId}`);
    const next = await this.modelService.resolve(effective);
    if (!(await this.modelService.isConfigured(next.providerId))) {
      throw new Error(`Provider is not configured: ${next.providerId}`);
    }
    this.activateModel(effective, next);
  }

  async useSharedModel(): Promise<void> {
    const shared = await this.configService.resolveSharedModel();
    if (!shared) throw new Error("Shared model is not configured");
    const next = await this.modelService.resolve(shared);
    if (!(await this.modelService.isConfigured(next.providerId))) {
      throw new Error(`Provider is not configured: ${next.providerId}`);
    }
    await this.configService.removeAgentModel(this.agentId, { scope: "global" });
    await this.configService.removeAgentModel(this.agentId, { scope: "project" });
    const effective = await this.configService.resolveModel(this.agentId);
    if (!effective) throw new Error("Shared model is not configured");
    this.activateModel(effective, next);
  }

  get modelSelection(): ModelSelection {
    return this.activeSelection;
  }

  async dispose(): Promise<void> {
    await this.extensions.dispose();
  }

  private async persistProduced(event: AgentEvent): Promise<void> {
    if (event.type === "done" && event.produced) {
      await this.sessions.append(this.requireSessionId(), event.produced);
    }
  }

  private requireSessionId(): string {
    const sessionId = this.sessions.currentId;
    if (!sessionId) throw new Error("Agent session is not initialized");
    return sessionId;
  }

  private activateModel(selection: ModelSelection, model: AgentConfig["model"]): void {
    this.activeSelection = selection;
    this.agentConfig.model = model;
  }
}

export interface AgentApplicationDependencies {
  readonly extensions: ExtensionManager;
  readonly sessions: AgentSessionRepository;
  readonly agentConfig: AgentConfig;
  readonly agentId: string;
  readonly cwd: string;
  readonly modelService: ModelService;
  readonly modelSelection: ModelSelection;
  readonly configService: ConfigService;
}
