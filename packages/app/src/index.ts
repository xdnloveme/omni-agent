export { AgentApplication } from "./application/agent-application";
export type { AgentApplicationDependencies } from "./application/agent-application";
export { createAgentApp } from "./application/create-agent-app";
export type { CreateAgentAppOptions } from "./application/create-agent-app";
export { AgentRegistry } from "./registry/agent-registry";
export { ToolRegistry } from "./registry/tool-registry";
export { CommandRegistry } from "./registry/command-registry";
export { ExtensionManager } from "./extensions/extension-manager";
export { loadAgentExtensions } from "./extensions/agent-extension-loader";
export type { AgentFactory, AgentFactoryContext } from "./extensions/agent-factory";
export type {
  AgentExtensionLoaderOptions,
  AgentExtensionLoadResult,
} from "./extensions/agent-extension-loader";
export type {
  AgentContribution,
  AgentExtension,
  AgentExtensionContext,
  AgentExtensionContributions,
  AgentExtensionManifest,
  ExtensionDiagnostic,
  ToolExposure,
} from "./extensions/types";
export { SessionService } from "./sessions/session-service";
export { ConfigService } from "./config/config-service";
export type { ConfigServiceOptions } from "./config/config-service";
export type { ConfigDiagnostic, OmniConfigV2 } from "./config/types";
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
