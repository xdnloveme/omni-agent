import type { ModelSelection } from "../models/model-service";

export interface OmniConfigV2 {
  version: 2;
  model: ModelSelection;
}

export interface ConfigDiagnostic {
  code: "invalid_config" | "migration_failed";
  message: string;
}
