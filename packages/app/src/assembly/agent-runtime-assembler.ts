import { join } from "node:path";
import {
  AgentSessionRepository,
  digestStableValue,
  EnvironmentContextController,
  ToolAccessController,
  ToolCallCoordinator,
  ToolInputValidator,
  ToolInvocationRunner,
  type AgentConfig,
} from "@omni-agent/core";
import { AgentApplication } from "../application/agent-application";
import { AgentMcpController } from "../mcp/agent-mcp-controller";
import { McpActivationStore } from "../mcp/activation-store";
import { McpCatalogService, McpSdkClient, KeychainMcpCredentialStore } from "../mcp";
import type { AgentInstance } from "../application/agent-factory";
import { createContextRuntime } from "../context/contextRuntime";
import { ContextSidecarLayout } from "../context/sidecarLayout";
import { ExtensionManager } from "../extensions/extension-manager";
import { ModelCacheLeaseController } from "../models/cache/model-cache-lease-controller";
import { ModelCacheLeaseRepository } from "../models/cache/model-cache-lease-repository";
import { ExecutionSettingsRepository, ExecutionSettingsService } from "../execution-settings";
import { ToolRegistry } from "../registry/tool-registry";
import { AgentScopedTraceRuntime } from "../tracing";
import { WorkspaceStorageLayout } from "../workspaces";
import { AgentAssemblyEvidence } from "./agent-assembly-evidence";
import { AssemblyTransaction } from "./assembly-transaction";
import { toAgentAssemblyError, type AgentAssemblyStage } from "./errors";
import type {
  AgentAssemblyEnvironment,
  AgentAssemblyFacts,
  ExtensionCandidate,
  ResolvedAgentAssemblyPlan,
} from "./contracts";

export class AgentRuntimeAssembler {
  async assemble(
    plan: ResolvedAgentAssemblyPlan,
    environment: AgentAssemblyEnvironment,
  ): Promise<AgentInstance> {
    const transaction = new AssemblyTransaction();
    const agentId = plan.manifest.metadata.id;
    const executionSettings = new ExecutionSettingsService(
      new ExecutionSettingsRepository(plan.globalDirectory),
    );
    let stage: AgentAssemblyStage = "blueprint_build";
    let source = plan.packageName;
    try {
      const module = await environment.blueprint.build({
        manifest: plan.manifest,
        composition: plan.composition,
        cwd: plan.workspace.root,
        interaction: environment.host.interactionSurface,
        execution: {
          getMode: async () =>
            (await executionSettings.getSettings(plan.workspace.id, agentId)).mode,
        },
      });
      if (module.dispose) transaction.defer("agent_module", () => module.dispose!());
      stage = "module_validation";
      validateModule(agentId, module, plan.composition);

      stage = "extension_activation";
      const toolInputValidator = new ToolInputValidator();
      const manager = new ExtensionManager({
        cwd: plan.workspace.root,
        modelProviders: environment.modelService.providerPlugins,
        tools: new ToolRegistry(toolInputValidator),
        reservedCommandNames: environment.host.reservedCommandNames,
      });
      transaction.defer("extension_manager", () => manager.dispose());

      const registered: AgentAssemblyFacts["extensions"][number][] = [];
      const builtin: ExtensionCandidate = {
        sourceOriginId: `builtin-${agentId}`,
        diagnosticSource: plan.packageName,
        requirement: "required",
        extension: module.extension,
      };
      await manager.register(builtin.extension, `builtin-${builtin.extension.manifest.id}`);
      registered.push(extensionFact(builtin));

      const sourceLoader = environment.extensionSourceLoader;
      if (sourceLoader && plan.extensionSources.length > 0) {
        source = "extension-sources";
        const loaded = await sourceLoader.load(plan.extensionSources);
        manager.diagnostics.push(...loaded.diagnostics);
        for (const candidate of loaded.candidates) {
          source = candidate.diagnosticSource;
          const activated =
            candidate.requirement === "required"
              ? await registerRequired(manager, candidate)
              : await manager.registerOptional(
                  candidate.extension,
                  candidate.diagnosticSource,
                  candidate.extension.manifest.id,
                );
          if (activated) registered.push(extensionFact(candidate));
        }
      }

      stage = "agent_resolution";
      source = plan.packageName;
      const contribution = manager.agents.get(agentId);
      if (!contribution) throw new Error(`Agent not registered: ${agentId}`);
      stage = "runtime_composition";
      const instructions = contribution.definition.instructions;
      const systemPrompt =
        typeof instructions === "function"
          ? await instructions({ cwd: plan.workspace.root })
          : instructions;
      const tools = manager.tools.resolve(contribution.tools);
      const agentConfig: AgentConfig = {
        model: plan.resolvedModel,
        systemPrompt,
        tools,
        toolBatchPreparationPolicies: contribution.definition.toolBatchPreparationPolicies,
        middleware: manager.middleware,
        toolLifecycleAdapters: module.capabilities.skills?.runtime.lifecycleAdapters(),
        hooks: manager.hooks,
        onHookDiagnostic: (value) =>
          manager.diagnostics.push({
            extensionId: "builtin-hooks",
            source: value.hookId,
            message: `${value.code}: ${value.message}`,
          }),
      };

      const workspaceStorage = new WorkspaceStorageLayout(plan.globalDirectory);
      stage = "workspace";
      source = plan.workspace.id;
      await workspaceStorage.ensureInitialized(plan.workspace);
      const sessionsRoot = workspaceStorage.sessionsRoot(plan.workspace.id);
      stage = "session";
      source = "session-repository";
      const sessions = new AgentSessionRepository({ agentId, sessionsRoot });
      await sessions.restoreLatestOrCreate();
      const sidecarLayout = new ContextSidecarLayout(join(sessionsRoot, agentId, "context"));
      const diagnostic = (extensionId: string, source: string, message: string) =>
        manager.diagnostics.push({ extensionId, source, message });
      const cacheDiagnostic = (message: string) =>
        diagnostic("builtin-model-cache", "model-cache-sidecar", message);
      const cacheLeases = new ModelCacheLeaseController(
        environment.modelService.runtime,
        new ModelCacheLeaseRepository(sidecarLayout, cacheDiagnostic),
        cacheDiagnostic,
      );
      stage = "cache";
      source = "model-cache-sidecar";
      await cacheLeases.hydrate(sessions.snapshot().sessionId);
      stage = "context";
      source = "context-runtime";
      const { contextEngine, contextStorage } = createContextRuntime({
        layout: sidecarLayout,
        agentConfig,
        artifactRecovery: module.capabilities.context?.artifactRecovery,
        policyStages: [
          ...(module.capabilities.context?.policyStages ?? []),
          ...manager.contextPolicyStages,
        ],
        skillStrategies: module.capabilities.skills?.runtime.contextProjectionStrategies(),
        modelRuntime: environment.modelService.runtime,
        cacheLeaseAdvisor: environment.modelService.runtime.leaseAdvisor,
        onDiagnostic: (message) => diagnostic("builtin-context", "context-sidecar", message),
      });
      stage = "access";
      source = "access-runtime";
      const accessController = new ToolAccessController({
        settings: executionSettings,
        consent: environment.host.accessConsentBroker,
      });
      stage = "runtime_composition";
      source = "tool-call-runtime";
      const toolCallCoordinator = new ToolCallCoordinator({
        accessController,
        processPlanner: environment.host.processPlanner,
        invocationRunner: new ToolInvocationRunner({
          processRouter: environment.host.processRouter,
          onLateSettlement: environment.host.onLateToolSettlement,
        }),
        inputValidator: toolInputValidator,
        hostRuntime: environment.host.hostRuntime,
        networkRuntime: environment.host.networkRuntime,
      });
      stage = "environment";
      source = "runtime-environment-provider";
      const environmentContext = new EnvironmentContextController(
        requireEnvironmentProvider(environment.host),
      );

      stage = "trace";
      source = "agent-scoped-trace-runtime";
      const assemblyEvidence = new AgentAssemblyEvidence({
        agentId,
        packageName: plan.packageName,
        packageVersion: plan.packageVersion,
        manifestApiVersion: plan.manifest.apiVersion,
        blueprintApiVersion: plan.manifest.runtime.blueprintApiVersion,
        workspaceId: plan.workspace.id,
        model: {
          vendorId: plan.modelSelection.vendorId,
          connectionId: plan.modelSelection.connectionId,
          modelId: plan.modelSelection.modelId,
        },
        extensions: registered,
        composition: {
          promptProfileId: plan.composition.prompt.profileId,
          promptContributorIds: plan.composition.prompt.contributorIds,
          toolComponentIds: plan.composition.tools.componentIds,
          capabilityIds: [
            plan.composition.capabilities.skillsId,
            plan.composition.capabilities.artifactRecoveryId,
          ].filter((id): id is string => id !== undefined),
        },
        toolNames: tools.map((tool) => tool.name),
        systemPromptDigest: digestStableValue(systemPrompt),
      });
      const traceRuntime = new AgentScopedTraceRuntime({
        globalDirectory: plan.globalDirectory,
        agentId,
        workspaceId: plan.workspace.id,
        cwd: plan.workspace.root,
        assembly: () => assemblyEvidence.snapshot(),
        onDiagnostic: (value) => diagnostic("builtin-tracing", value.operation, value.message),
      });
      transaction.defer("trace_runtime", () => traceRuntime.dispose());

      stage = "application";
      source = "agent-application";
      let mcpConfigs: import("../mcp/config/types").ResolvedMcpConfiguration = {
        servers: [],
        diagnostics: [],
      };
      try {
        mcpConfigs = await environment.configService.resolveMcpServers();
      } catch (error) {
        diagnostic(
          "builtin-mcp",
          "configuration",
          error instanceof Error ? error.message : String(error),
        );
      }
      const application = new AgentApplication({
        mcp: new AgentMcpController(
          mcpConfigs,
          new McpActivationStore(join(sessionsRoot, agentId, "mcp-activation.json")),
          new McpCatalogService(
            manager.tools,
            new McpSdkClient(
              new KeychainMcpCredentialStore(),
              environment.host.mcpEnvironment,
              environment.host.mcpOAuthInteraction,
            ),
          ),
          toolCallCoordinator,
          {
            agentId,
            workspaceId: plan.workspace.id,
            workspaceRoot: plan.workspace.root,
            cwd: plan.workspace.root,
            middleware: [],
            lifecycleAdapters: [],
          },
        ),
        extensions: manager,
        agentModule: module,
        sessions,
        agentConfig,
        agentId,
        cwd: plan.workspace.root,
        modelService: environment.modelService,
        modelSelection: plan.modelSelection,
        configService: environment.configService,
        executionSettings,
        workspaceId: plan.workspace.id,
        toolCallCoordinator,
        contextEngine,
        contextMiddleware: manager.contextMiddleware,
        contextStorage,
        environmentContext,
        cacheLeases,
        runObservation: traceRuntime,
        assemblyEvidence,
      });
      try {
        await application.initializeMcp();
      } catch (error) {
        diagnostic(
          "builtin-mcp",
          "activation",
          error instanceof Error ? error.message : String(error),
        );
      }
      transaction.commit();
      let disposePromise: Promise<void> | undefined;
      return {
        id: agentId,
        manifest: plan.manifest,
        get assembly() {
          return assemblyEvidence.snapshot();
        },
        application,
        capabilities: module.capabilities,
        trace: traceRuntime.capability,
        dispose: () => (disposePromise ??= application.dispose()),
      };
    } catch (error) {
      return transaction.rollback(toAgentAssemblyError(error, agentId, stage, source));
    }
  }
}

function requireEnvironmentProvider(
  host: AgentAssemblyEnvironment["host"],
): NonNullable<AgentAssemblyEnvironment["host"]["environmentProvider"]> {
  if (!host.environmentProvider) {
    throw new Error("AgentFactory must normalize the Runtime Environment Provider");
  }
  return host.environmentProvider;
}

async function registerRequired(
  manager: ExtensionManager,
  candidate: ExtensionCandidate,
): Promise<true> {
  await manager.register(candidate.extension, candidate.extension.manifest.id);
  return true;
}

function extensionFact(candidate: ExtensionCandidate): AgentAssemblyFacts["extensions"][number] {
  return {
    id: candidate.extension.manifest.id,
    version: candidate.extension.manifest.version,
    sourceOriginId: candidate.sourceOriginId,
    requirement: candidate.requirement,
  };
}

function validateModule(
  expectedId: string,
  module: Awaited<ReturnType<AgentAssemblyEnvironment["blueprint"]["build"]>>,
  composition: ResolvedAgentAssemblyPlan["composition"],
): void {
  const definitions = module.extension.contributions.agents;
  if (definitions?.length !== 1 || definitions[0]?.definition.id !== expectedId) {
    throw new Error(`Agent extension must contribute exactly one matching agent: ${expectedId}`);
  }
  const definition = definitions[0]!.definition;
  if (definition.maxTurns !== undefined) {
    throw new Error(`Agent Blueprint must not set maxTurns: ${expectedId}`);
  }
  const contributedToolNames = (module.extension.contributions.tools ?? []).map(({ name }) => name);
  assertEqualOrder("contributed Tools", contributedToolNames, composition.tools.toolNames);
  const exposure = definitions[0]!.tools.include;
  if (exposure === "*")
    throw new Error(`Agent Blueprint must expose explicit Tool names: ${expectedId}`);
  assertEqualOrder("exposed Tools", exposure, composition.tools.toolNames);

  const hasSkills = module.capabilities.skills !== undefined;
  if (hasSkills !== (composition.capabilities.skillsId !== undefined)) {
    throw new Error(
      `Agent Blueprint Skills capability does not match the Assembly Plan: ${expectedId}`,
    );
  }
  const artifactRecovery = module.capabilities.context?.artifactRecovery;
  if (
    (artifactRecovery !== undefined) !==
    (composition.capabilities.artifactRecoveryId !== undefined)
  ) {
    throw new Error(
      `Agent Blueprint Artifact Recovery capability does not match the Assembly Plan: ${expectedId}`,
    );
  }
  if (artifactRecovery && !composition.tools.toolNames.includes(artifactRecovery.toolName)) {
    throw new Error(
      `Agent Blueprint Artifact Recovery references an unexposed Tool: ${artifactRecovery.toolName}`,
    );
  }
}

function assertEqualOrder(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `Agent Blueprint ${label} do not match the Assembly Plan: expected [${expected.join(", ")}], received [${actual.join(", ")}]`,
    );
  }
}
