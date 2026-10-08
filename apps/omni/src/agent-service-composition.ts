import {
  AgentFactory,
  AgentService,
  AgentServiceAccessConsentBroker,
  ConfigService,
  createModelService,
  resolveWorkspaceContext,
  type AgentServicePort,
  type ExtensionSourceLoader,
  type AgentModelService,
  type ModelServiceDiagnostic,
} from "@omni-agent/app";
import { createDefaultAgentPackageCatalog } from "@omni-agent/cli";
import { DenyAccessConsentBroker, RejectingInteractionSurface } from "@omni-agent/core";
import { createNetworkRuntime } from "@omni-agent/network";
import { createProcessExecutionRuntime, type HostRuntimeEnvironment } from "@omni-agent/tools";

export interface AgentServiceCompositionOptions {
  readonly modelService?: AgentModelService;
  readonly traceEnabled?: boolean;
  readonly cwd: string;
  readonly configurationDirectory?: string;
  readonly globalDirectory: string;
  readonly resolutionBase: string;
  readonly agentPackagesDirectory: string;
  readonly hostRuntime: HostRuntimeEnvironment;
  readonly extensionSourceLoader?: ExtensionSourceLoader;
  readonly interactivePermissions?: boolean;
}

export interface AgentServiceComposition {
  readonly service: AgentServicePort;
  readonly modelDiagnostics: readonly ModelServiceDiagnostic[];
  dispose(): Promise<void>;
}

export async function createAgentServiceComposition(
  options: AgentServiceCompositionOptions,
): Promise<AgentServiceComposition> {
  const workspace = await resolveWorkspaceContext(options.cwd);
  const configService = new ConfigService({
    cwd: options.configurationDirectory ?? workspace.root,
    globalDirectory: options.configurationDirectory ?? options.globalDirectory,
  });
  const modelService =
    options.modelService ??
    (await createModelService({
      cwd: options.configurationDirectory ?? workspace.root,
      globalDirectory: options.configurationDirectory ?? options.globalDirectory,
    }));
  try {
    const catalog = createDefaultAgentPackageCatalog({
      resolutionBase: options.resolutionBase,
      agentPackagesDirectory: options.agentPackagesDirectory,
    });
    const processExecution = createProcessExecutionRuntime(options.hostRuntime);
    const permissions =
      options.interactivePermissions === false ? undefined : new AgentServiceAccessConsentBroker();
    const factory = new AgentFactory({
      workspace,
      globalDirectory: options.globalDirectory,
      configService,
      modelService,
      extensionSourceLoader: options.extensionSourceLoader,
      host: {
        traceEnabled: options.traceEnabled,
        interactionSurface: new RejectingInteractionSurface(),
        accessConsentBroker: permissions ?? new DenyAccessConsentBroker(),
        processRouter: processExecution.router,
        processPlanner: processExecution.planner,
        hostRuntime: processExecution.hostRuntime,
        networkRuntime: createNetworkRuntime(),
        mcpEnvironment: Object.freeze({ ...process.env }),
        reservedCommandNames: [],
      },
    });
    const service = permissions
      ? new AgentService({ catalog, factory, permissions })
      : new AgentService({ catalog, factory });
    let disposePromise: Promise<void> | undefined;
    return {
      service,
      modelDiagnostics: modelService.diagnostics,
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
        "Failed to create and roll back Agent Service composition",
        { cause: error },
      );
    }
    throw error;
  }
}

async function disposeComposition(
  service: AgentService,
  modelService: AgentModelService,
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
    throw new AggregateError(failures, "Failed to dispose Agent Service composition");
  }
}
