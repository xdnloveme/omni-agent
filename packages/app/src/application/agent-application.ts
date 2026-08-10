import {
  AgentRunner,
  createStreamSession,
  type AgentConfig,
  type AgentEvent,
  type StreamCallbacks,
} from "@omni-agent/core";
import { ExtensionManager } from "../extensions/extension-manager";
import { SessionService } from "../sessions/session-service";
import { ModelService, type ModelSelection } from "../models/model-service";

export class AgentApplication {
  readonly runner: AgentRunner;
  readonly extensions: ExtensionManager;
  readonly sessions: SessionService;
  readonly agentConfig: AgentConfig;
  readonly agentId: string;
  readonly cwd: string;
  readonly modelService: ModelService;
  private activeSelection: ModelSelection;
  private readonly persistModelSelection?: (selection: ModelSelection) => void | Promise<void>;
  private readonly ownsModelService: boolean;

  constructor(dependencies: AgentApplicationDependencies) {
    this.extensions = dependencies.extensions;
    this.sessions = dependencies.sessions;
    this.agentConfig = dependencies.agentConfig;
    this.agentId = dependencies.agentId;
    this.cwd = dependencies.cwd;
    this.modelService = dependencies.modelService;
    this.activeSelection = dependencies.modelSelection;
    this.persistModelSelection = dependencies.persistModelSelection;
    this.ownsModelService = dependencies.ownsModelService ?? false;
    this.runner = new AgentRunner(dependencies.modelService.runtime);
  }

  async run(input: string, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    this.sessions.appendUserInput(input);
    const streamSession = createStreamSession(callbacks);
    const events = this.runner.run(this.agentConfig, this.sessions.messages, signal, {
      session: streamSession,
    });
    for await (const event of events) {
      this.persistProduced(event);
    }
  }

  newSession(): string {
    return this.sessions.create();
  }

  clearSession(): void {
    this.sessions.clear();
  }

  async refreshInstructions(): Promise<void> {
    const contribution = this.extensions.agents.get(this.agentId);
    if (!contribution) throw new Error(`Agent not found: ${this.agentId}`);
    const instructions = contribution.definition.instructions;
    this.agentConfig.systemPrompt =
      typeof instructions === "function" ? await instructions({ cwd: this.cwd }) : instructions;
  }

  async setModel(selection: ModelSelection): Promise<void> {
    const next = await this.modelService.resolve(selection);
    const auth = await this.modelService.isConfigured(next.providerId);
    if (!auth) throw new Error(`Provider is not configured: ${next.providerId}`);
    await this.persistModelSelection?.(selection);
    this.activateModel(selection, next);
  }

  get modelSelection(): ModelSelection {
    return this.activeSelection;
  }

  async dispose(): Promise<void> {
    try {
      await this.extensions.dispose();
    } finally {
      if (this.ownsModelService) await this.modelService.dispose();
    }
  }

  private persistProduced(event: AgentEvent): void {
    if (event.type === "done" && event.produced) {
      this.sessions.appendProduced(event.produced);
    }
  }

  private activateModel(selection: ModelSelection, model: AgentConfig["model"]): void {
    this.activeSelection = selection;
    this.agentConfig.model = model;
  }
}

export interface AgentApplicationDependencies {
  readonly extensions: ExtensionManager;
  readonly sessions: SessionService;
  readonly agentConfig: AgentConfig;
  readonly agentId: string;
  readonly cwd: string;
  readonly modelService: ModelService;
  readonly modelSelection: ModelSelection;
  readonly persistModelSelection?: (selection: ModelSelection) => void | Promise<void>;
  readonly ownsModelService?: boolean;
}
