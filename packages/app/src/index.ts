export {
  AgentApplication,
  AgentApplicationDisposalError,
  AgentApplicationLifecycleError,
} from "./application/agent-application";
export { NodeRuntimeEnvironmentProvider } from "./environment/index";
export type { NodeRuntimeEnvironmentProviderOptions } from "./environment/index";
export type {
  AgentApplicationState,
  AgentResourceDisposalFailure,
} from "./application/agent-application";
export type {
  AgentRunObservationPort,
  AgentRunObservationRequest,
} from "./application/agent-run-observation";
export { AgentServiceAccessConsentBroker } from "./application/permissions/service-access-consent-broker";
export type {
  AgentServicePermissionEvent,
  PermissionPresentation,
} from "./application/permissions/service-access-consent-broker";
export {
  ContextSidecarLayout,
  ContextProjectionRepository,
  ContextProjectionRevisionError,
  CacheBackedContextRewriteGuard,
  ContextCheckpointRepository,
  RuntimeContextSummaryGenerator,
} from "./context/index";
export { AgentFactory } from "./application/agent-factory";
export {
  AgentAssemblyError,
  AgentModelNotConfiguredError,
  AssemblyRollbackError,
} from "./assembly/errors";
export type {
  AgentAssemblyFailure,
  AgentAssemblyStage,
  ResourceCleanupFailure,
} from "./assembly/errors";
export type { AgentFactoryOptions, AgentInstance } from "./application/agent-factory";
export { AgentPackageCatalog } from "./agent-packages/agent-package-catalog";
export type { AgentPackageCatalogOptions } from "./agent-packages/agent-package-catalog";
export {
  AgentPackageCatalogError,
  type AgentPackageCatalogErrorCode,
  type AgentPackageCatalogPort,
  type AgentPackageDescriptor,
  type AgentPackageModule,
  type AgentPackageRegistration,
} from "./agent-packages/contracts";
export { AgentService } from "./application/agent-service/agent-service";
export type { AgentServiceOptions } from "./application/agent-service/agent-service";
export { toAgentServiceFailure } from "./application/agent-service/agent-service-failure";
export {
  AgentServiceDisposalError,
  AgentServiceError,
  type AgentServiceAgent,
  type AgentServiceErrorCode,
  type AgentServiceEvent,
  type AgentServiceFailure,
  type AgentServicePort,
  type AgentServiceResourceDisposalFailure,
  type AgentServiceRunRequest,
  type AgentServiceSession,
  type AgentServiceState,
} from "./application/agent-service/contracts";
export {
  parseAgentManifest,
  AgentManifestError,
  MAX_AGENT_MANIFEST_BYTES,
} from "./assembly/agent-manifest-validator";
export { validateAgentBlueprintDescriptor } from "./assembly/agent-blueprint-descriptor-validator";
export {
  AgentCompositionPlanner,
  AgentCompositionPlanningError,
} from "./assembly/agent-composition-planner";
export type { AgentCompositionErrorCode } from "./assembly/agent-composition-planner";
export type {
  AgentBlueprintDescriptor,
  AgentCompositionRecipe,
  AgentAssemblySnapshot,
  AgentBlueprint,
  AgentBlueprintContext,
  AgentCapabilities,
  AgentHostDependencies,
  AgentManifest,
  AgentModule,
  ComponentDescriptor,
  DependentComponentDescriptor,
  ExtensionSourceLoader,
  ExtensionSourceLoadResult,
  ExtensionSourceReference,
  ExtensionCandidate,
  LoadedAgentPackage,
  ResolvedAgentComposition,
  SkillCapability,
  ToolBundleDescriptor,
  ToolComponentDescriptor,
  ToolRecipeEntry,
} from "./assembly/contracts";
export { AgentRegistry } from "./registry/agent-registry";
export { ToolRegistry } from "./registry/tool-registry";
export { CommandRegistry } from "./registry/command-registry";
export {
  ExtensionActivationRollbackError,
  ExtensionCleanupError,
  ExtensionManager,
  type ExtensionCleanupFailure,
} from "./extensions/extension-manager";
export type {
  AgentContribution,
  AgentExtension,
  AgentExtensionContext,
  AgentExtensionContributions,
  AgentExtensionManifest,
  ExtensionDiagnostic,
  ToolExposure,
} from "./extensions/types";
export { ConfigService } from "./config/config-service";
export { ExecutionSettingsRepository, ExecutionSettingsService } from "./execution-settings/index";
export type {
  PersistedAgentExecutionSettings,
  PersistedExecutionSettings,
} from "./execution-settings/index";
export type { ConfigServiceOptions } from "./config/config-service";
export type {
  AgentModelConfig,
  ConfigDiagnostic,
  OmniConfig,
  ResolvedModelConfiguration,
} from "./config/types";
export { ModelService, createModelService } from "./models/model-service";
export type { ModelServiceDiagnostic } from "./models/model-service";
export type {
  ModelAuthEvent,
  ModelAuthInteraction,
  ModelAuthMethod,
  ModelAuthPrompt,
  ModelAuthType,
  ModelSelection,
  ModelServiceOptions,
  VendorSettingsSchema,
} from "./models/model-service";
export { ProviderRegistrationCoordinator } from "./models/provider-registration-coordinator";
export { resolveWorkspaceContext } from "./workspaces/index";
export type { WorkspaceContext } from "./workspaces/index";
export { createLocalTraceMaintenance, createLocalTraceQuery } from "./tracing/index";
export type {
  AgentTraceInspection,
  AgentTraceControlCapability,
  TraceMaintenancePort,
  TraceQueryPort,
} from "./tracing/index";
export * from "./mcp/index";
