import {
  AgentFactory,
  AgentService,
  AgentServiceAccessConsentBroker,
  ConfigService,
  createModelService,
  resolveWorkspaceContext,
  type AgentServicePort,
  type ModelService,
} from "@omni-agent/app";
import { createDefaultAgentPackageCatalog } from "@omni-agent/cli";
import { RejectingInteractionSurface } from "@omni-agent/core";
import { createNetworkRuntime } from "@omni-agent/network";
import { createProcessExecutionRuntime, type HostRuntimeEnvironment } from "@omni-agent/tools";

export interface AgentHostCompositionOptions {
  readonly cwd: string;
  readonly globalDirectory: string;
  readonly resolutionBase: string;
  readonly agentPackagesDirectory: string;
  readonly hostRuntime: HostRuntimeEnvironment;
}

export interface AgentHostComposition {
  readonly service: AgentServicePort;
  dispose(): Promise<void>;
}

export async function createAgentHostComposition(
  options: AgentHostCompositionOptions,
): Promise<AgentHostComposition> {
  const workspace = await resolveWorkspaceContext(options.cwd);
  const configService = new ConfigService({
    cwd: workspace.root,
    globalDirectory: options.globalDirectory,
  });
  const modelService = await createModelService({
    cwd: workspace.root,
    globalDirectory: options.globalDirectory,
  });
  try {
    const catalog = createDefaultAgentPackageCatalog({
      resolutionBase: options.resolutionBase,
      agentPackagesDirectory: options.agentPackagesDirectory,
    });
    const processExecution = createProcessExecutionRuntime(options.hostRuntime);
    const permissions = new AgentServiceAccessConsentBroker();
    const factory = new AgentFactory({
      workspace,
      globalDirectory: options.globalDirectory,
      configService,
      modelService,
      host: {
        interactionSurface: new RejectingInteractionSurface(),
        accessConsentBroker: permissions,
        processRouter: processExecution.router,
        processPlanner: processExecution.planner,
        hostRuntime: processExecution.hostRuntime,
        networkRuntime: createNetworkRuntime(),
        mcpEnvironment: Object.freeze({ ...process.env }),
        reservedCommandNames: [],
      },
    });
    const service = new AgentService({ catalog, factory, permissions });
    let disposePromise: Promise<void> | undefined;
    return {
      service,
      dispose() {
        disposePromise ??= disposeComposition(service, modelService);
        return disposePromise;
      },
    };
  } catch (error) {
    try {
      await modelService.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to create and roll back Agent Host composition",
        { cause: error },
      );
    }
    throw error;
  }
}

async function disposeComposition(
  service: AgentService,
  modelService: ModelService,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await service.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    await modelService.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to dispose Agent Host composition");
  }
}
