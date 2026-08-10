import type { ModelSelection } from "../models/model-service";

export interface AgentModelConfig {
  model: ModelSelection;
}

export interface OmniConfig {
  version: 3;
  model: ModelSelection;
  agents?: Record<string, AgentModelConfig>;
}

export interface ConfigDiagnostic {
  code: "invalid_config" | "read_failed";
  source: "global" | "project";
  message: string;
}
