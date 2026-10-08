import type { AgentConfig } from "@omni-agent/core";
import type { AgentAssemblyEvidence } from "../assembly/agent-assembly-evidence";
import type { ConfigService } from "../config/config-service";
import type { ExtensionManager } from "../extensions/extension-manager";
import type { ModelSelection, AgentModelService } from "../models/model-service";

export interface AgentConfigurationControllerDependencies {
  readonly additionalInstructions?: () => string;
  readonly agentId: string;
  readonly cwd: string;
  readonly agentConfig: AgentConfig;
  readonly initialModelSelection: ModelSelection;
  readonly extensions: ExtensionManager;
  readonly configService: ConfigService;
  readonly modelService: AgentModelService;
  readonly assemblyEvidence?: AgentAssemblyEvidence;
}

/** Owns all effective runtime configuration transitions for one Agent instance. */
export class AgentConfigurationController {
  private activeSelection: ModelSelection;
  private baseSystemPrompt: string;

  constructor(private readonly dependencies: AgentConfigurationControllerDependencies) {
    this.activeSelection = dependencies.initialModelSelection;
    this.baseSystemPrompt = dependencies.agentConfig.systemPrompt;
  }

  get modelSelection(): ModelSelection {
    return this.activeSelection;
  }

  async refreshInstructions(): Promise<void> {
    const { agentId, cwd, extensions } = this.dependencies;
    const contribution = extensions.agents.get(agentId);
    if (!contribution) throw new Error(`Agent not found: ${agentId}`);
    const instructions = contribution.definition.instructions;
    this.baseSystemPrompt =
      typeof instructions === "function" ? await instructions({ cwd }) : instructions;
    this.refreshAdditionalInstructions();
  }

  refreshAdditionalInstructions(): void {
    const systemPrompt = [this.baseSystemPrompt, this.dependencies.additionalInstructions?.()]
      .filter(Boolean)
      .join("\n\n");
    this.dependencies.assemblyEvidence?.updateSystemPrompt(systemPrompt);
    this.dependencies.agentConfig.systemPrompt = systemPrompt;
  }

  async setAgentModel(selection: ModelSelection): Promise<void> {
    await this.assertConfigured(selection);
    const { agentId, configService } = this.dependencies;
    await configService.saveAgentModel(agentId, selection, { scope: "global" });
    await this.activateEffectiveModel();
  }

  async setSharedModel(selection: ModelSelection): Promise<void> {
    await this.assertConfigured(selection);
    await this.dependencies.configService.saveSharedModel(selection, { scope: "global" });
    await this.activateEffectiveModel();
  }

  async useSharedModel(): Promise<void> {
    const { agentId, configService } = this.dependencies;
    const current = await configService.resolveModelConfiguration(agentId);
    if (current?.scope === "project" && current.kind === "agent") {
      throw new Error(
        `Cannot remove the project-level override for ${agentId}; edit omni.config.json manually`,
      );
    }
    await configService.removeAgentModel(agentId, { scope: "global" });
    await this.activateEffectiveModel();
  }

  private async assertConfigured(selection: ModelSelection): Promise<void> {
    const model = await this.dependencies.modelService.resolve(selection);
    if (!(await this.dependencies.modelService.isConfigured(model.providerId))) {
      throw new Error(`Provider is not configured: ${model.providerId}`);
    }
  }

  private async activateEffectiveModel(): Promise<void> {
    const { agentId, configService, modelService, assemblyEvidence, agentConfig } =
      this.dependencies;
    const selection = await configService.resolveModel(agentId);
    if (!selection) throw new Error(`Model is not configured for agent: ${agentId}`);
    const model = await modelService.resolve(selection);
    if (!(await modelService.isConfigured(model.providerId))) {
      throw new Error(`Provider is not configured: ${model.providerId}`);
    }
    assemblyEvidence?.updateModel(selection);
    this.activeSelection = selection;
    agentConfig.model = model;
  }
}
