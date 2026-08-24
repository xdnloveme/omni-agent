import {
  AgentPackageCatalogError,
  type AgentPackageCatalogErrorCode,
} from "../../agent-packages/contracts";
import { AgentApplicationLifecycleError } from "../agent-application";
import {
  AgentServiceDisposalError,
  AgentServiceError,
  type AgentServiceFailure,
} from "./contracts";

export function toAgentServiceFailure(error: unknown): AgentServiceFailure {
  if (error instanceof AgentServiceError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof AgentPackageCatalogError) {
    return { code: error.code, message: catalogFailureMessage(error.code), retryable: false };
  }
  if (error instanceof AgentApplicationLifecycleError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof AgentServiceDisposalError) {
    return {
      code: error.code,
      message: "Agent service cleanup failed",
      retryable: false,
    };
  }
  return {
    code: "agent_service_operation_failed",
    message: "Agent service operation failed",
    retryable: false,
  };
}

function catalogFailureMessage(code: AgentPackageCatalogErrorCode): string {
  switch (code) {
    case "agent_not_registered":
      return "Agent is not available";
    case "agent_manifest_not_found":
      return "Agent definition was not found";
    case "agent_manifest_invalid":
    case "agent_package_incompatible":
    case "agent_identity_mismatch":
    case "agent_blueprint_missing":
    case "agent_blueprint_invalid":
      return "Agent definition is invalid";
    case "agent_package_load_failed":
      return "Agent package could not be loaded";
  }
}
