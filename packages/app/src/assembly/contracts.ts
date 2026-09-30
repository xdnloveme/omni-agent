import type {
  ContextCapability,
  ExecutionMode,
  InteractionSurfacePort,
  LateToolSettlementEvent,
  AccessConsentBroker,
  ProcessExecutionRouterPort,
  ProcessExecutionPlannerPort,
  HostRuntimeContext,
  RuntimeEnvironmentProviderPort,
  RuntimeModelSelection,
  SkillRuntime,
} from "@omni-agent/core";
import type { ConfigService } from "../config/config-service";
import type { AgentExtension } from "../extensions/types";
import type { ModelSelection, AgentModelService } from "../models/model-service";
import type { WorkspaceContext } from "../workspaces";

export interface AgentManifest {
  readonly apiVersion: "omni-agent/v2";
  readonly kind: "Agent";
  readonly metadata: {
    readonly id: string;
    readonly displayName: string;
  };
  readonly runtime: {
    readonly blueprintApiVersion: 2;
  };
  readonly description: string;
  readonly composition: AgentCompositionRecipe;
}

export interface AgentCompositionRecipe {
  readonly prompt: {
    readonly profile: string;
    readonly contributors: readonly string[];
  };
  readonly tools: {
    readonly sequence: readonly ToolRecipeEntry[];
  };
  readonly capabilities: {
    readonly skills?: string;
    readonly context?: {
      readonly artifactRecovery?: string;
    };
  };
}

export type ToolRecipeEntry =
  | { readonly bundle: string; readonly tool?: never }
  | { readonly tool: string; readonly bundle?: never };

export interface ComponentDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}

export interface DependentComponentDescriptor extends ComponentDescriptor {
  readonly requiresCapabilities?: readonly string[];
  readonly requiresTools?: readonly string[];
}

export interface ToolComponentDescriptor extends DependentComponentDescriptor {
  readonly toolName: string;
}

export interface ToolBundleDescriptor extends ComponentDescriptor {
  readonly tools: readonly string[];
}

export interface AgentBlueprintDescriptor {
  readonly promptProfiles: readonly ComponentDescriptor[];
  readonly promptContributors: readonly DependentComponentDescriptor[];
  readonly toolBundles: readonly ToolBundleDescriptor[];
  readonly tools: readonly ToolComponentDescriptor[];
  readonly capabilities: {
    readonly skills: readonly ComponentDescriptor[];
    readonly artifactRecovery: readonly DependentComponentDescriptor[];
  };
}

export interface ResolvedAgentComposition {
  readonly prompt: {
    readonly profileId: string;
    readonly contributorIds: readonly string[];
  };
  readonly tools: {
    readonly componentIds: readonly string[];
    readonly toolNames: readonly string[];
  };
  readonly capabilities: {
    readonly skillsId?: string;
    readonly artifactRecoveryId?: string;
  };
}

export interface SkillCapability {
  readonly runtime: SkillRuntime;
}

export interface AgentCapabilities {
  readonly skills?: SkillCapability;
  readonly context?: ContextCapability;
}

export interface AgentBlueprintContext {
  readonly manifest: AgentManifest;
  readonly composition: ResolvedAgentComposition;
  readonly cwd: string;
  readonly interaction: InteractionSurfacePort;
  readonly execution: { getMode(): Promise<ExecutionMode> };
}

export interface AgentModule {
  readonly extension: AgentExtension;
  readonly capabilities: AgentCapabilities;
  dispose?(): void | Promise<void>;
}

export interface AgentBlueprint {
  readonly descriptor: AgentBlueprintDescriptor;
  build(context: AgentBlueprintContext): AgentModule | Promise<AgentModule>;
}

export interface LoadedAgentPackage {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly manifest: AgentManifest;
  readonly blueprint: AgentBlueprint;
}

export interface ExtensionSourceReference {
  readonly sourceOriginId: string;
  readonly diagnosticSource: string;
  readonly requirement: "required" | "optional";
}

export interface ExtensionCandidate extends ExtensionSourceReference {
  readonly extension: AgentExtension;
}

export interface ExtensionSourceLoadResult {
  readonly candidates: readonly ExtensionCandidate[];
  readonly diagnostics: readonly {
    readonly extensionId: string;
    readonly source: string;
    readonly message: string;
  }[];
}

export interface ExtensionSourceLoader {
  load(references: readonly ExtensionSourceReference[]): Promise<ExtensionSourceLoadResult>;
}

export interface AgentHostDependencies {
  /** Initial capture policy; omitted preserves the default disabled Trace state. */
  readonly traceEnabled?: boolean;
  readonly interactionSurface: InteractionSurfacePort;
  readonly accessConsentBroker: AccessConsentBroker;
  readonly processRouter: ProcessExecutionRouterPort;
  readonly processPlanner: ProcessExecutionPlannerPort;
  readonly hostRuntime: HostRuntimeContext;
  readonly networkRuntime: import("@omni-agent/core").NetworkRuntimePort;
  readonly mcpEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly mcpOAuthInteraction?: import("../mcp").McpOAuthInteractionPort;
  readonly environmentProvider?: RuntimeEnvironmentProviderPort;
  readonly reservedCommandNames: readonly string[];
  readonly onLateToolSettlement?: (event: LateToolSettlementEvent) => void | Promise<void>;
}

export interface AgentAssemblyRequest {
  readonly agentPackage: LoadedAgentPackage;
  readonly workspace: WorkspaceContext;
  readonly workspaceRoots: readonly string[];
  readonly globalDirectory: string;
  readonly configService: ConfigService;
  readonly modelService: AgentModelService;
  readonly host: AgentHostDependencies;
  readonly extensionSourceLoader?: ExtensionSourceLoader;
}

export interface ResolvedAgentAssemblyInput extends AgentAssemblyRequest {
  readonly modelSelection: ModelSelection;
  readonly resolvedModel: RuntimeModelSelection;
  readonly extensionSources: readonly ExtensionSourceReference[];
}

export interface ResolvedAgentAssemblyPlan {
  readonly manifest: AgentManifest;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly workspace: WorkspaceContext;
  readonly workspaceRoots: readonly string[];
  readonly globalDirectory: string;
  readonly modelSelection: ModelSelection;
  readonly resolvedModel: RuntimeModelSelection;
  readonly extensionSources: readonly ExtensionSourceReference[];
  readonly composition: ResolvedAgentComposition;
}

export interface AgentAssemblyEnvironment {
  readonly blueprint: AgentBlueprint;
  readonly configService: ConfigService;
  readonly modelService: AgentModelService;
  readonly host: AgentHostDependencies;
  readonly extensionSourceLoader?: ExtensionSourceLoader;
}

export interface AgentAssemblyFacts {
  readonly agentId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly manifestApiVersion: string;
  readonly blueprintApiVersion: number;
  readonly workspaceId: string;
  readonly model: {
    readonly vendorId: string;
    readonly connectionId: string;
    readonly modelId: string;
  };
  readonly extensions: readonly {
    readonly id: string;
    readonly version: string;
    readonly sourceOriginId: string;
    readonly requirement: "required" | "optional";
  }[];
  readonly composition: {
    readonly promptProfileId: string;
    readonly promptContributorIds: readonly string[];
    readonly toolComponentIds: readonly string[];
    readonly capabilityIds: readonly string[];
  };
  readonly toolNames: readonly string[];
  readonly systemPromptDigest: string;
}

export interface AgentAssemblySnapshot extends AgentAssemblyFacts {
  readonly digest: string;
}
