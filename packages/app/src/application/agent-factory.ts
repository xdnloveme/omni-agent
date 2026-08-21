import { resolve } from "node:path";
import { AgentAssemblyPlanner } from "../assembly/agent-assembly-planner";
import { AgentRuntimeAssembler } from "../assembly/agent-runtime-assembler";
import { AssemblyInputResolver } from "../assembly/assembly-input-resolver";
import { LocalExtensionSourceLoader } from "../assembly/extension-source-loader";
import { toAgentAssemblyError } from "../assembly/errors";
import { NodeRuntimeEnvironmentProvider } from "../environment";
import type {
  AgentAssemblySnapshot,
  AgentCapabilities,
  AgentHostDependencies,
  AgentManifest,
  ExtensionSourceLoader,
  LoadedAgentPackage,
  ResolvedAgentAssemblyPlan,
} from "../assembly/contracts";
import type { ConfigService } from "../config/config-service";
import type { ModelService } from "../models/model-service";
import type { AgentTraceControlCapability } from "../tracing";
import type { WorkspaceContext } from "../workspaces";
import type { AgentApplication } from "./agent-application";

export interface AgentInstance {
  readonly id: string;
  readonly manifest: AgentManifest;
  readonly assembly: AgentAssemblySnapshot;
  readonly application: AgentApplication;
  readonly capabilities: AgentCapabilities;
  readonly trace?: AgentTraceControlCapability;
  dispose(): Promise<void>;
}

export interface AgentFactoryOptions {
  readonly workspace: WorkspaceContext;
  readonly workspaceRoots?: readonly string[];
  readonly globalDirectory: string;
  readonly configService: ConfigService;
  readonly modelService: ModelService;
  readonly host: AgentHostDependencies;
  readonly extensionSourceLoader?: ExtensionSourceLoader;
}

export class AgentFactory {
  constructor(private readonly options: AgentFactoryOptions) {}

  async create(agentPackage: LoadedAgentPackage): Promise<AgentInstance> {
    const cwd = this.options.workspace.root;
    const globalDirectory = this.options.globalDirectory;
    const extensionSourceLoader =
      this.options.extensionSourceLoader ?? new LocalExtensionSourceLoader();
    const workspaceRoots = normalizeWorkspaceRoots(cwd, this.options.workspaceRoots);
    const host: AgentHostDependencies = {
      ...this.options.host,
      environmentProvider:
        this.options.host.environmentProvider ??
        new NodeRuntimeEnvironmentProvider({
          cwd,
          workspaceRoots,
        }),
    };
    const input = await new AssemblyInputResolver().resolve({
      agentPackage,
      workspace: this.options.workspace,
      workspaceRoots,
      globalDirectory,
      configService: this.options.configService,
      modelService: this.options.modelService,
      host,
      extensionSourceLoader,
    });
    let plan: ResolvedAgentAssemblyPlan;
    try {
      plan = new AgentAssemblyPlanner().plan(input);
    } catch (error) {
      throw toAgentAssemblyError(
        error,
        agentPackage.manifest.metadata.id,
        "planning",
        agentPackage.packageName,
      );
    }
    return new AgentRuntimeAssembler().assemble(plan, {
      blueprint: agentPackage.blueprint,
      configService: this.options.configService,
      modelService: this.options.modelService,
      host,
      extensionSourceLoader,
    });
  }
}

function normalizeWorkspaceRoots(
  workspaceRoot: string,
  additionalRoots: readonly string[] | undefined,
): readonly string[] {
  return [
    ...new Set([
      resolve(workspaceRoot),
      ...(additionalRoots ?? []).map((root) => resolve(workspaceRoot, root)),
    ]),
  ];
}
