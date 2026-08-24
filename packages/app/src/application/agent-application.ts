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
  type ExecutionMode,
  type FilesystemCapabilityScope,
  type EnvironmentContextControllerPort,
  type SessionSnapshot,
} from "@omni-agent/core";
import type { RuntimeRunObservation } from "@omni-agent/core/host";
import type { AgentSessionRepository } from "@omni-agent/core";
import { ConfigService } from "../config/config-service";
import { ExtensionManager } from "../extensions/extension-manager";
import { ModelService, type ModelSelection } from "../models/model-service";
import type { ExecutionSettingsService } from "../execution-settings/execution-settings-service";
import type { ModelCacheLeaseController } from "../models/cache/model-cache-lease-controller";
import { NOOP_AGENT_RUN_OBSERVATION, type AgentRunObservationPort } from "./agent-run-observation";
import type { AgentModule } from "../assembly/contracts";
import type { AgentAssemblyEvidence } from "../assembly/agent-assembly-evidence";
import { AgentConfigurationController } from "./agent-configuration-controller";

export type AgentApplicationState = "ready" | "disposing" | "disposed";

export class AgentApplicationLifecycleError extends Error {
  constructor(readonly code: "agent_application_closed" | "agent_application_busy") {
    super(
      code === "agent_application_busy"
        ? "Agent application is busy"
        : "Agent application is closed",
    );
    this.name = "AgentApplicationLifecycleError";
  }
}

export interface AgentResourceDisposalFailure {
  readonly resource: "extensions" | "agent_module" | "run_observation";
  readonly error: unknown;
}

export class AgentApplicationDisposalError extends AggregateError {
  readonly code = "agent_application_disposal_failed";

  constructor(readonly failures: readonly AgentResourceDisposalFailure[]) {
    super(
      failures.map(({ error }) => error),
      "Failed to dispose Agent application",
    );
    this.name = "AgentApplicationDisposalError";
  }
}

export class AgentApplication {
  readonly runner: AgentRunner;
  readonly extensions: ExtensionManager;
  readonly sessions: AgentSessionRepository;
  readonly agentConfig: AgentConfig;
  readonly agentId: string;
  readonly cwd: string;
  readonly modelService: ModelService;
  readonly executionSettings: ExecutionSettingsService;
  readonly workspaceId: string;
  private readonly configuration: AgentConfigurationController;
  private readonly contextStorage: ContextSessionStorage;
  private readonly environmentContext: EnvironmentContextControllerPort;
  private readonly cacheLeases: ModelCacheLeaseController;
  private readonly runObservation: AgentRunObservationPort;
  private readonly agentModule?: AgentModule;
  private applicationState: AgentApplicationState = "ready";
  private activeRunCount = 0;
  private sessionMutationActive = false;
  private disposePromise: Promise<void> | undefined;

  constructor(dependencies: AgentApplicationDependencies) {
    this.extensions = dependencies.extensions;
    this.sessions = dependencies.sessions;
    this.agentConfig = dependencies.agentConfig;
    this.agentId = dependencies.agentId;
    this.cwd = dependencies.cwd;
    this.modelService = dependencies.modelService;
    this.contextStorage = dependencies.contextStorage;
    this.environmentContext = dependencies.environmentContext;
    this.cacheLeases = dependencies.cacheLeases;
    this.runObservation = dependencies.runObservation ?? NOOP_AGENT_RUN_OBSERVATION;
    this.agentModule = dependencies.agentModule;
    this.configuration = new AgentConfigurationController({
      agentId: dependencies.agentId,
      cwd: dependencies.cwd,
      agentConfig: dependencies.agentConfig,
      initialModelSelection: dependencies.modelSelection,
      extensions: dependencies.extensions,
      configService: dependencies.configService,
      modelService: dependencies.modelService,
      assemblyEvidence: dependencies.assemblyEvidence,
    });
    this.executionSettings = dependencies.executionSettings;
    this.workspaceId = dependencies.workspaceId;
    this.runner = new AgentRunner(
      dependencies.modelService.runtime,
      dependencies.toolCallCoordinator,
      dependencies.agentId,
      dependencies.workspaceId,
      dependencies.cwd,
      dependencies.environmentContext,
      dependencies.contextEngine,
      dependencies.contextMiddleware,
    );
  }

  async run(input: string, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    this.assertIdle();
    this.activeRunCount += 1;
    try {
      const sessionId = this.requireSessionId();
      await this.runObservation.observe(
        { sessionId, input, callbacks, signal },
        (observation, observedCallbacks) =>
          this.executeRun(input, observedCallbacks, sessionId, observation, signal),
      );
    } finally {
      this.activeRunCount -= 1;
    }
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
    return this.mutateSession(async () => {
      const session = await this.sessions.create();
      await this.cacheLeases.hydrate(session.id);
      return session.id;
    });
  }

  async openSession(sessionId: string): Promise<SessionSnapshot> {
    return this.mutateSession(async () => {
      const session = await this.sessions.switchTo(sessionId);
      await this.cacheLeases.hydrate(session.id);
      return this.sessions.snapshot();
    });
  }

  currentSessionSnapshot(): SessionSnapshot {
    return this.sessions.snapshot();
  }

  async clearSession(): Promise<void> {
    await this.mutateSession(async () => {
      const sessionId = this.requireSessionId();
      await this.sessions.clear(sessionId);
      await this.contextStorage.clear(sessionId);
      this.cacheLeases.forget(sessionId);
    });
  }

  async refreshInstructions(): Promise<void> {
    await this.configuration.refreshInstructions();
  }

  async setAgentModel(selection: ModelSelection): Promise<void> {
    await this.configuration.setAgentModel(selection);
  }

  async setSharedModel(selection: ModelSelection): Promise<void> {
    await this.configuration.setSharedModel(selection);
  }

  async useSharedModel(): Promise<void> {
    await this.configuration.useSharedModel();
  }

  get modelSelection(): ModelSelection {
    return this.configuration.modelSelection;
  }

  getExecutionSettings() {
    return this.executionSettings.getSettings(this.workspaceId, this.agentId);
  }

  async setExecutionMode(mode: ExecutionMode): Promise<void> {
    await this.executionSettings.setMode(this.workspaceId, this.agentId, mode);
    await this.refreshInstructions();
  }

  setControlledNetworkEnabled(enabled: boolean): Promise<void> {
    return this.executionSettings.setControlledNetworkEnabled(
      this.workspaceId,
      this.agentId,
      enabled,
    );
  }

  revokeApprovedFilesystemRoot(root: FilesystemCapabilityScope) {
    return this.executionSettings.revokeApprovedFilesystemRoot(
      this.workspaceId,
      this.agentId,
      root,
    );
  }

  clearApprovedFilesystemRoots(): Promise<void> {
    return this.executionSettings.clearApprovedFilesystemRoots(this.workspaceId, this.agentId);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.applicationState === "disposed") return Promise.resolve();
    if (this.activeRunCount > 0 || this.sessionMutationActive) {
      return Promise.reject(new AgentApplicationLifecycleError("agent_application_busy"));
    }
    this.applicationState = "disposing";
    this.disposePromise = this.disposeOwnedResources();
    return this.disposePromise;
  }

  private async disposeOwnedResources(): Promise<void> {
    const failures: AgentResourceDisposalFailure[] = [];
    const resources: readonly {
      readonly resource: AgentResourceDisposalFailure["resource"];
      readonly dispose: () => void | Promise<void> | undefined;
    }[] = [
      { resource: "extensions", dispose: () => this.extensions.dispose() },
      { resource: "agent_module", dispose: () => this.agentModule?.dispose?.() },
      { resource: "run_observation", dispose: () => this.runObservation.dispose() },
    ];
    for (const resource of resources) {
      try {
        await resource.dispose();
      } catch (error) {
        failures.push({ resource: resource.resource, error });
      }
    }
    this.applicationState = "disposed";
    this.disposePromise = undefined;
    if (failures.length > 0) throw new AgentApplicationDisposalError(failures);
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

  private assertIdle(): void {
    if (this.applicationState !== "ready") {
      throw new AgentApplicationLifecycleError("agent_application_closed");
    }
    if (this.activeRunCount > 0 || this.sessionMutationActive) {
      throw new AgentApplicationLifecycleError("agent_application_busy");
    }
  }

  private async mutateSession<T>(operation: () => Promise<T>): Promise<T> {
    this.assertIdle();
    this.sessionMutationActive = true;
    try {
      return await operation();
    } finally {
      this.sessionMutationActive = false;
    }
  }
}

export interface AgentApplicationDependencies {
  readonly extensions: ExtensionManager;
  readonly agentModule?: AgentModule;
  readonly sessions: AgentSessionRepository;
  readonly agentConfig: AgentConfig;
  readonly agentId: string;
  readonly cwd: string;
  readonly modelService: ModelService;
  readonly modelSelection: ModelSelection;
  readonly configService: ConfigService;
  readonly executionSettings: ExecutionSettingsService;
  readonly workspaceId: string;
  readonly toolCallCoordinator: ToolCallCoordinator;
  readonly contextEngine: ContextEnginePort;
  readonly contextMiddleware: readonly ContextMiddlewarePort[];
  readonly contextStorage: ContextSessionStorage;
  readonly environmentContext: EnvironmentContextControllerPort;
  readonly cacheLeases: ModelCacheLeaseController;
  readonly runObservation?: AgentRunObservationPort;
  readonly assemblyEvidence?: AgentAssemblyEvidence;
}

export interface ContextSessionStorage {
  clear(sessionId: string): Promise<void>;
}
