export type AgentAssemblyStage =
  | "input_resolution"
  | "planning"
  | "blueprint_build"
  | "module_validation"
  | "extension_activation"
  | "agent_resolution"
  | "runtime_composition"
  | "workspace"
  | "session"
  | "cache"
  | "context"
  | "permissions"
  | "environment"
  | "trace"
  | "application";

export class AgentAssemblyError extends Error {
  readonly code = "agent_assembly_failed";

  constructor(
    readonly agentId: string,
    readonly stage: AgentAssemblyStage,
    readonly source: string,
    cause: unknown,
  ) {
    super(`Failed to assemble Agent ${agentId} during ${stage} (${source})`, { cause });
    this.name = "AgentAssemblyError";
  }
}

export class AgentModelNotConfiguredError extends Error {
  readonly code = "agent_model_not_configured";
  readonly stage = "input_resolution";
  readonly source = "configuration";

  constructor(readonly agentId: string) {
    super(`Model is not configured for agent: ${agentId}`);
    this.name = "AgentModelNotConfiguredError";
  }
}

export type AgentAssemblyFailure = AgentAssemblyError | AgentModelNotConfiguredError;

export interface ResourceCleanupFailure {
  readonly resource: string;
  readonly error: unknown;
}

export class AssemblyRollbackError extends AggregateError {
  readonly code = "agent_assembly_rollback_failed";

  constructor(
    readonly assemblyError: unknown,
    readonly cleanupFailures: readonly ResourceCleanupFailure[],
  ) {
    super(
      [assemblyError, ...cleanupFailures.map(({ error }) => error)],
      "Agent assembly and rollback failed",
      { cause: assemblyError },
    );
    this.name = "AssemblyRollbackError";
  }
}

export function toAgentAssemblyError(
  error: unknown,
  agentId: string,
  stage: AgentAssemblyStage,
  source: string = stage,
): AgentAssemblyFailure {
  return error instanceof AgentAssemblyError || error instanceof AgentModelNotConfiguredError
    ? error
    : new AgentAssemblyError(agentId, stage, source, error);
}
