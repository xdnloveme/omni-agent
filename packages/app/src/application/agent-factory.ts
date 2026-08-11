import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentSessionRepository,
  isAgentId,
  ToolAuthorizationRouter,
  ToolCallCoordinator,
  ToolInvocationRunner,
  ToolInputValidator,
  type AgentConfig,
  type ApprovalBroker,
  type PermissionObserver,
  type SandboxRunnerPort,
  type SkillRuntime,
} from "@omni-agent/core";
import { AgentApplication } from "./agent-application";
import type { ConfigService } from "../config/config-service";
import { loadAgentExtensions } from "../extensions/agent-extension-loader";
import { ExtensionManager } from "../extensions/extension-manager";
import type { AgentExtension } from "../extensions/types";
import type { ModelService } from "../models/model-service";
import { createPermissionRuntime } from "../permissions/create-permission-runtime";
import { ToolRegistry } from "../registry/tool-registry";

export interface SkillCapability {
  readonly runtime: SkillRuntime;
  readonly buildSystemPrompt: () => Promise<string>;
}

export interface AgentCapabilities {
  readonly skills?: SkillCapability;
}

export interface AgentBlueprintContext {
  readonly cwd: string;
}

export interface AgentModule {
  readonly id: string;
  readonly extension: AgentExtension;
  readonly capabilities: AgentCapabilities;
}

export interface AgentBlueprint {
  readonly id: string;
  build(context: AgentBlueprintContext): AgentModule | Promise<AgentModule>;
}

export interface AgentInstance {
  readonly id: string;
  readonly application: AgentApplication;
  readonly capabilities: AgentCapabilities;
  dispose(): Promise<void>;
}

export interface AgentFactoryOptions {
  readonly cwd?: string;
  readonly globalDirectory?: string;
  readonly configService: ConfigService;
  readonly modelService: ModelService;
  readonly loadExtensions?: boolean;
  readonly approvalBroker?: ApprovalBroker;
  readonly permissionObserver?: PermissionObserver;
  readonly sandboxRunner?: SandboxRunnerPort;
}

export class AgentFactory {
  private readonly cwd: string;
  private readonly globalDirectory: string;

  constructor(private readonly options: AgentFactoryOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.globalDirectory = options.globalDirectory ?? join(homedir(), ".omni-agent");
  }

  async create(blueprint: AgentBlueprint): Promise<AgentInstance> {
    assertAgentId(blueprint.id);
    const selection = await this.options.configService.resolveModel(blueprint.id);
    if (!selection) throw new AgentModelNotConfiguredError(blueprint.id);
    const resolvedModel = await this.options.modelService.resolve(selection);
    if (!(await this.options.modelService.isConfigured(resolvedModel.providerId))) {
      throw new Error(`Provider is not configured: ${resolvedModel.providerId}`);
    }

    const module = await blueprint.build({ cwd: this.cwd });
    validateModule(blueprint.id, module);
    const toolInputValidator = new ToolInputValidator();
    const manager = new ExtensionManager({
      cwd: this.cwd,
      modelProviders: this.options.modelService.providerPlugins,
      tools: new ToolRegistry(toolInputValidator),
    });

    try {
      await manager.register(module.extension, `builtin-${blueprint.id}`);
      if (this.options.loadExtensions !== false) {
        const loaded = await loadAgentExtensions({
          cwd: this.cwd,
          globalDirectory: this.globalDirectory,
        });
        manager.diagnostics.push(...loaded.diagnostics);
        for (const entry of loaded.extensions) {
          await manager.registerOptional(entry.extension, entry.source);
        }
      }

      const contribution = manager.agents.get(blueprint.id);
      if (!contribution) throw new Error(`Agent not registered: ${blueprint.id}`);
      const instructions = contribution.definition.instructions;
      const systemPrompt =
        typeof instructions === "function" ? await instructions({ cwd: this.cwd }) : instructions;
      const agentConfig: AgentConfig = {
        model: resolvedModel,
        systemPrompt,
        tools: manager.tools.resolve(contribution.tools),
        middleware: manager.middleware,
        maxTurns: contribution.definition.maxTurns,
        toolLifecycleAdapters: module.capabilities.skills?.runtime.lifecycleAdapters(),
      };
      const sessions = new AgentSessionRepository({
        agentId: blueprint.id,
        sessionsRoot: join(this.globalDirectory, "sessions"),
      });
      await sessions.restoreLatestOrCreate();
      const permissions = createPermissionRuntime({
        globalDirectory: this.globalDirectory,
        approvalBroker: this.options.approvalBroker,
        observer: this.options.permissionObserver,
      });
      const toolCallCoordinator = new ToolCallCoordinator({
        authorizer: new ToolAuthorizationRouter(permissions.permissionGate),
        invocationRunner: new ToolInvocationRunner({ sandboxRunner: this.options.sandboxRunner }),
        inputValidator: toolInputValidator,
      });
      const application = new AgentApplication({
        extensions: manager,
        sessions,
        agentConfig,
        agentId: blueprint.id,
        cwd: this.cwd,
        modelService: this.options.modelService,
        modelSelection: selection,
        configService: this.options.configService,
        permissionService: permissions.service,
        toolCallCoordinator,
      });
      let disposed = false;
      return {
        id: blueprint.id,
        application,
        capabilities: module.capabilities,
        async dispose() {
          if (disposed) return;
          disposed = true;
          await application.dispose();
        },
      };
    } catch (error) {
      try {
        await manager.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to create agent ${blueprint.id}`);
      }
      throw error;
    }
  }
}

export class AgentModelNotConfiguredError extends Error {
  constructor(readonly agentId: string) {
    super(`Model is not configured for agent: ${agentId}`);
  }
}

function validateModule(expectedId: string, module: AgentModule): void {
  if (module.id !== expectedId) {
    throw new Error(`Agent module id mismatch: expected ${expectedId}, received ${module.id}`);
  }
  const definitions = module.extension.contributions.agents ?? [];
  if (definitions.length !== 1 || definitions[0].definition.id !== expectedId) {
    throw new Error(`Agent extension must contribute exactly one matching agent: ${expectedId}`);
  }
}

function assertAgentId(agentId: string): void {
  if (!isAgentId(agentId)) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
}
