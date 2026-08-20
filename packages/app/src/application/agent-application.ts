import {
  AgentRunner,
  EnvironmentContextError,
  createUserMessage,
  createStreamSession,
  type AgentConfig,
  type AgentEvent,
  type StreamCallbacks,
  type ToolCallCoordinator,
  type ContextEnginePort,
  type ContextMiddlewarePort,
  type PermissionMode,
  type EnvironmentContextControllerPort,
  type SessionSnapshot,
} from "@omni-agent/core";
import type { RuntimeRunObservation } from "@omni-agent/core/host";
import type { AgentSessionRepository } from "@omni-agent/core";
import { ConfigService } from "../config/config-service";
import { ExtensionManager } from "../extensions/extension-manager";
import { ModelService, type ModelSelection } from "../models/model-service";
import type { PermissionService } from "../permissions/permission-service";
import type { ModelCacheLeaseController } from "../models/cache/model-cache-lease-controller";
import { NOOP_AGENT_RUN_OBSERVATION, type AgentRunObservationPort } from "./agent-run-observation";

export class AgentApplication {
  readonly runner: AgentRunner;
  readonly extensions: ExtensionManager;
  readonly sessions: AgentSessionRepository;
  readonly agentConfig: AgentConfig;
  readonly agentId: string;
  readonly cwd: string;
  readonly modelService: ModelService;
  readonly permissions: PermissionService;
  private activeSelection: ModelSelection;
  private readonly configService: ConfigService;
  private readonly contextStorage: ContextSessionStorage;
  private readonly environmentContext: EnvironmentContextControllerPort;
  private readonly cacheLeases: ModelCacheLeaseController;
  private readonly runObservation: AgentRunObservationPort;

  constructor(dependencies: AgentApplicationDependencies) {
    this.extensions = dependencies.extensions;
    this.sessions = dependencies.sessions;
    this.agentConfig = dependencies.agentConfig;
    this.agentId = dependencies.agentId;
    this.cwd = dependencies.cwd;
    this.modelService = dependencies.modelService;
    this.activeSelection = dependencies.modelSelection;
    this.configService = dependencies.configService;
    this.contextStorage = dependencies.contextStorage;
    this.environmentContext = dependencies.environmentContext;
    this.cacheLeases = dependencies.cacheLeases;
    this.runObservation = dependencies.runObservation ?? NOOP_AGENT_RUN_OBSERVATION;
    this.permissions = dependencies.permissionService;
    this.runner = new AgentRunner(
      dependencies.modelService.runtime,
      dependencies.toolCallCoordinator,
      dependencies.agentId,
      dependencies.environmentContext,
      dependencies.contextEngine,
      dependencies.contextMiddleware,
    );
  }

  async run(input: string, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.runObservation.observe(
      { sessionId, input, callbacks, signal },
      (observation, observedCallbacks) =>
        this.executeRun(input, observedCallbacks, sessionId, observation, signal),
    );
  }

  private async executeRun(
    input: string,
    callbacks: StreamCallbacks,
    sessionId: string,
    observation: RuntimeRunObservation,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.cacheLeases.hydrate(sessionId);
    const streamSession = createStreamSession(callbacks);
    const captureObservation = observation.startOperation({ kind: "environment_capture" });
    let capture;
    try {
      capture = await captureObservation.run(() =>
        this.environmentContext.capture(this.sessions.snapshot().environment, signal),
      );
      captureObservation.complete({});
    } catch (error) {
      captureObservation.fail({ error });
      if (!(error instanceof EnvironmentContextError)) throw error;
      streamSession.handle({
        type: "error",
        failure: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.field ? { field: error.field } : {}),
        },
      });
      return;
    }
    const appendInput = () =>
      this.sessions.append(sessionId, [
        ...(capture.changed ? [{ kind: "environment" as const, context: capture.context }] : []),
        { kind: "message", message: createUserMessage(input) },
      ]);
    const appendObservation = observation.startOperation({ kind: "session_append_input" });
    try {
      await appendObservation.run(appendInput);
      appendObservation.complete({});
    } catch (error) {
      appendObservation.fail({ error });
      throw error;
    }
    const events = this.runner.run(
      this.agentConfig,
      this.sessions.snapshot(),
      signal,
      { session: streamSession },
      observation,
    );
    for await (const event of events) {
      await this.persistProduced(sessionId, event, observation);
    }
  }

  async newSession(): Promise<string> {
    const session = await this.sessions.create();
    await this.cacheLeases.hydrate(session.id);
    return session.id;
  }

  currentSessionSnapshot(): SessionSnapshot {
    return this.sessions.snapshot();
  }

  async clearSession(): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.sessions.clear(sessionId);
    await this.contextStorage.clear(sessionId);
    this.cacheLeases.forget(sessionId);
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
    await this.configService.saveAgentModel(this.agentId, selection, { scope: "global" });
    const effective = await this.requireEffectiveModel();
    this.activateModel(effective.selection, effective.model);
  }

  async setSharedModel(selection: ModelSelection): Promise<void> {
    const shared = await this.modelService.resolve(selection);
    if (!(await this.modelService.isConfigured(shared.providerId))) {
      throw new Error(`Provider is not configured: ${shared.providerId}`);
    }
    await this.configService.saveSharedModel(selection, { scope: "global" });
    const effective = await this.requireEffectiveModel();
    this.activateModel(effective.selection, effective.model);
  }

  async useSharedModel(): Promise<void> {
    const current = await this.configService.resolveModelConfiguration(this.agentId);
    if (current?.scope === "project" && current.kind === "agent") {
      throw new Error(
        `Cannot remove the project-level override for ${this.agentId}; edit omni.config.json manually`,
      );
    }
    await this.configService.removeAgentModel(this.agentId, { scope: "global" });
    const effective = await this.requireEffectiveModel();
    this.activateModel(effective.selection, effective.model);
  }

  get modelSelection(): ModelSelection {
    return this.activeSelection;
  }

  getPermissionMode(): Promise<PermissionMode> {
    return this.permissions.getMode(this.agentId);
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.permissions.setMode(this.agentId, mode);
  }

  listPersistentApprovals() {
    return this.permissions.listPersistentApprovals(this.agentId);
  }

  revokePersistentApproval(id: string): Promise<void> {
    return this.permissions.revokePersistentApproval(this.agentId, id);
  }

  clearPersistentApprovals(): Promise<void> {
    return this.permissions.clearPersistentApprovals(this.agentId);
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([
      this.extensions.dispose(),
      this.runObservation.dispose(),
    ]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose Agent application");
  }

  private async persistProduced(
    sessionId: string,
    event: AgentEvent,
    observation: RuntimeRunObservation,
  ): Promise<void> {
    if (event.type === "model_cache_report") {
      await this.cacheLeases.persist(sessionId, event.report);
    }
    const produced = event.type === "done" || event.type === "error" ? event.produced : undefined;
    if (produced?.length) {
      const persistObservation = observation.startOperation({ kind: "session_persist_output" });
      try {
        await persistObservation.run(() => this.sessions.append(sessionId, produced));
        persistObservation.complete({});
      } catch (error) {
        persistObservation.fail({ error });
        throw error;
      }
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

  private async requireEffectiveModel(): Promise<{
    selection: ModelSelection;
    model: AgentConfig["model"];
  }> {
    const selection = await this.configService.resolveModel(this.agentId);
    if (!selection) throw new Error(`Model is not configured for agent: ${this.agentId}`);
    const model = await this.modelService.resolve(selection);
    if (!(await this.modelService.isConfigured(model.providerId))) {
      throw new Error(`Provider is not configured: ${model.providerId}`);
    }
    return { selection, model };
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
  readonly permissionService: PermissionService;
  readonly toolCallCoordinator: ToolCallCoordinator;
  readonly contextEngine: ContextEnginePort;
  readonly contextMiddleware: readonly ContextMiddlewarePort[];
  readonly contextStorage: ContextSessionStorage;
  readonly environmentContext: EnvironmentContextControllerPort;
  readonly cacheLeases: ModelCacheLeaseController;
  readonly runObservation?: AgentRunObservationPort;
}

export interface ContextSessionStorage {
  clear(sessionId: string): Promise<void>;
}
