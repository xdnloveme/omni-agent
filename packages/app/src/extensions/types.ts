import type {
  AgentDefinition,
  AgentToolDefinition,
  Command,
  ContextMiddlewarePort,
  ContextPolicyStagePort,
  RuntimeMiddleware,
} from "@omni-agent/core";
import type { VendorPlugin } from "@omni-agent/models";

export interface ToolExposure {
  include: string[] | "*";
  exclude?: string[];
}

export interface AgentContribution {
  definition: AgentDefinition<{ cwd: string }>;
  tools: ToolExposure;
}

export interface AgentExtensionContributions {
  agents?: AgentContribution[];
  tools?: AgentToolDefinition[];
  commands?: Command[];
  middleware?: RuntimeMiddleware[];
  contextMiddleware?: ContextMiddlewarePort[];
  contextPolicyStages?: ContextPolicyStagePort[];
  providers?: VendorPlugin[];
}

export interface AgentExtensionManifest {
  id: string;
  version: string;
  apiVersion: 1;
}

export interface AgentExtensionContext {
  cwd: string;
}

export interface AgentExtension {
  manifest: AgentExtensionManifest;
  contributions: AgentExtensionContributions;
  activate?(context: AgentExtensionContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface ExtensionDiagnostic {
  extensionId: string;
  source: string;
  message: string;
}
