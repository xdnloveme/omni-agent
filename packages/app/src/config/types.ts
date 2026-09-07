import type { ModelSelection } from "../models/model-service";
import type { ConfigurationScope } from "@omni-agent/models";

export interface AgentModelConfig {
  model: ModelSelection;
}

export interface OmniConfig {
  model: ModelSelection;
  agents?: Record<string, AgentModelConfig>;
  mcp?: { readonly servers: readonly import("../mcp/config/types").McpServerConfig[] };
}

export interface ResolvedModelConfiguration {
  readonly selection: ModelSelection;
  readonly scope: ConfigurationScope;
  readonly kind: "agent" | "shared";
}

export interface ConfigDiagnostic {
  code: "invalid_config" | "read_failed";
  source: "global" | "project";
  message: string;
}
