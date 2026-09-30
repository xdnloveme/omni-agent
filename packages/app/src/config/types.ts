import type { ModelSelection } from "../models/model-service";
import type { ConfigurationScope } from "@omni-agent/models";

export interface AgentModelConfig {
  model: ModelSelection;
}

export interface OmniConfig {
  model: ModelSelection;
  agents?: Record<string, AgentModelConfig>;
  outputRetention?: Partial<import("../persistence/session-artifact-store").OutputStorageLimits>;
  /** Preserved verbatim on model updates; MCP owns validation of this optional section. */
  mcp?: unknown;
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
