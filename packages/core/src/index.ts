export { runAgentLoop } from "./agent-loop";
export { estimateContextTextTokens } from "./tokenEstimate";
export * from "./hooks/index";
export {
  InteractionError,
  InteractionAbortError,
  RejectingInteractionSurface,
  validateInteractionRequest,
  validateInteractionResponse,
} from "./interaction/index";
export type {
  InteractionAction,
  InteractionCompletion,
  InteractionErrorCode,
  InteractionTermination,
  InteractionField,
  InteractionItemTone,
  InteractionMultiSelectField,
  InteractionOption,
  InteractionRequest,
  InteractionResponse,
  InteractionSingleSelectField,
  InteractionSurfacePort,
  InteractionTextField,
  InteractionTone,
  InteractionValue,
} from "./interaction/index";
export type { AgentLoopOptions } from "./agent-loop";
export {
  MAX_APPROVED_NETWORK_TARGETS,
  networkTargetFromUrl,
  networkTargetKey,
  networkTargetMatches,
  normalizeNetworkTarget,
  normalizeNetworkTargets,
} from "./network/index";
export type {
  AuthorizedNetworkClient,
  NetworkCapability,
  NetworkProxyRoute,
  NetworkRequest,
  NetworkResponse,
  NetworkStreamResponse,
  NetworkRuntimeContext,
  NetworkRuntimeLease,
  NetworkRuntimePort,
  NetworkTarget,
} from "./network/index";
export { createLoopProtection } from "./loop-protection/index";
export type { LoopProtection, ToolLoopDiagnostic } from "./loop-protection/index";
export { AgentRunner, defineAgent } from "./agent/index";
export type { AgentDefinition, AgentRunContext, AgentRunResult } from "./agent/index";
export {
  ApproximateContextTokenEstimator,
  ContextCompressionTargetError,
  ContextSummaryInputBudgetError,
  ContextPolicyPipeline,
  DefaultContextEngine,
  digestContextValue,
  HeavyCheckpointGateStage,
  InvalidContextPolicyResultError,
  InvalidMicroProjectionResultError,
  StableMicroCompressionStage,
  ArtifactProjectionStrategy,
  SkillProjectionStrategy,
  ThinkingProjectionStrategy,
  microCompressionThreshold,
  shouldAdvanceMicroCompression,
} from "./context/index";
export type {
  CheckpointContextEntry,
  ContextArtifactRecoveryCapability,
  ContextCapability,
  ContextCheckpoint,
  ContextCheckpointStorePort,
  ContextComponentManifest,
  ContextConversationSource,
  ContextDecision,
  ContextDraft,
  ContextEnginePort,
  ContextEntry,
  ContextFinalGateOptions,
  ContextFinalGatePort,
  ContextHistoryFrame,
  ContextMiddlewareOptions,
  ContextMiddlewarePort,
  ContextModelLimits,
  ContextPolicyPort,
  ContextPolicyResult,
  ContextPolicyResolveOptions,
  ContextPolicyStageManifest,
  ContextPolicyStageOptions,
  ContextPolicyStagePort,
  ContextPolicyStageResult,
  ContextPreparationRequest,
  ContextProjectionState,
  ContextProjectionStorePort,
  ContextToolCycle,
  ContextToolCycleView,
  ContextRewriteGuardDecision,
  ContextRewriteGuardInput,
  ContextRewriteGuardPort,
  ContextSummaryGeneratorPort,
  ContextSummaryRequest,
  ContextSummaryResult,
  ContextTokenEstimate,
  ContextCompressionKind,
  ContextCompressionOperationSummary,
  ContextCompressionReport,
  ContextCompressionReporterPort,
  ContextCompressionTrigger,
  ContextProgressEvent,
  ContextProgressSinkPort,
  ContextTokenEstimatorPort,
  ModelCallCompletedContext,
  ModelContextSnapshotManifest,
  PreparedModelContext,
  MicroDecisionStatus,
  MicroProjectionAssessment,
  MicroProjectionCandidate,
  MicroProjectionLossClass,
  MicroProjectionOptions,
  MicroProjectionRecord,
  MicroProjectionReplayOptions,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
  PendingContextArtifact,
  StableMicroCompressionDependencies,
  ToolResultArtifactEntry,
  TranscriptContextEntry,
} from "./context/index";
export {
  ToolCallCoordinator,
  ToolDefinitionValidator,
  ToolInputValidator,
} from "./tool-calls/index";
export type {
  ToolCallEnvironment,
  ToolCallEvent,
  ToolCallMetrics,
  ToolCallRequest,
  PreparedToolBatch,
  PreparedToolCall,
  PreparedToolExecutionContext,
  ToolBatchPreparationDecision,
  ToolBatchPreparationContext,
  ToolBatchPreparationPolicy,
  ToolBatchPreparationRequest,
  ValidatedToolResult,
  ToolPreflightDescriptor,
  ToolPreflightContext,
  ToolPreflightResult,
} from "./tool-calls/index";
export {
  createAbortError,
  isAbortError,
  resolveToolTimeout,
  throwIfAborted,
  OperationDeadlineSupervisor,
  ToolTimeoutError,
  ToolInvocationRunner,
  TextOutputPreview,
} from "./execution/index";
export type {
  AuthorizedExecutionContext,
  AuthorizedToolCall,
  ExecutionMode,
  HostRuntimeContext,
  ProcessExecutionPlan,
  ProcessAccessPlan,
  ProcessExecutionPlannerPort,
  ProcessExecutionPlanningRequest,
  ProcessExecutableRequirement,
  ProcessExecutionRouterPort,
  ProcessInvocation,
  ProcessResult,
  SandboxPathScope,
  SandboxPolicy,
  ToolExecutionContext,
  ToolExecutionPlan,
  ToolExecutionStrategy,
  ToolInvocationResult,
  ToolInvocationRunnerOptions,
  ToolTimeoutPolicy,
  LateToolSettlementEvent,
  LateOperationSettlementEvent,
  OperationDeadlineSupervisorOptions,
} from "./execution/index";
export {
  ExactSensitiveTextStreamSanitizer,
  formatSanitizedToolInput,
  redactExactSensitiveText,
  redactExactSensitiveValue,
  redactExactSensitiveError,
  sanitizeSensitiveValue,
  sanitizeSensitiveText,
} from "./security/index";
export type { SanitizationOptions, SensitiveValueSet } from "./security/index";
export { isInProcessTool, isProcessTool } from "./types";
export { ToolAccessController, DenyAccessConsentBroker } from "./access/index";
export {
  capabilityCoversResource,
  capabilityKey,
  candidateCanAuthorize,
  isConsentCandidateEligible,
  MAX_APPROVED_FILESYSTEM_ROOTS,
  normalizeFilesystemCapabilities,
  selectNarrowestCapability,
} from "./access/index";
export type {
  AccessConsentBroker,
  AccessConsentDecision,
  AccessConsentRequest,
  AccessConsentResponse,
  AccessResource,
  AccessSensitivity,
  ExecutionSettingsPort,
  FilesystemCapabilityScope,
  FilesystemConsentCandidate,
  PreparedToolAccess,
  ToolAccessContext,
  ToolAccessDescriptor,
  ToolAccessIntent,
  ToolAccessRequest,
  ToolAccessResult,
  ToolAccessGrant,
  WorkspaceExecutionSettings,
} from "./access/index";
export type { RunMiddleware, RuntimeMiddleware, ToolExecutionMiddleware } from "./middleware/index";
export { RuntimePromptComposer } from "./system-prompt/index";
export type { RuntimePromptLease, RuntimePromptSection } from "./system-prompt/index";
export { collectLifecycleEndEvents, collectLifecycleStartEvents } from "./tool-lifecycle";
export type {
  ToolLifecycleAdapter,
  ToolLifecycleEndInput,
  ToolLifecycleStartInput,
} from "./tool-lifecycle";
export { toContextMessages } from "./context/index";
export { isAgentId, isToolOriginId } from "./identifiers";
export type {
  AgentConfig,
  AgentEvent,
  AgentFailure,
  AgentLoopInput,
  AgentToolDefinition,
  InProcessToolDefinition,
  ProcessToolDefinition,
  RegisteredAgentTool,
  TokenUsage,
  ToolBatchDescriptor,
  ToolBatchMember,
  ToolBatchPosition,
  ToolInvocationAction,
  ToolInvocationPresentation,
  ToolInvocationPreview,
  ToolInvocationResourceKind,
  ToolContextPolicy,
  ToolSchedulingPolicy,
  ToolResult,
  ToolResultContent,
  ToolResourceReference,
  ToolResultMetadata,
  ToolResultPresentationData,
} from "./types";
export type { ExtensionEvent } from "./extension-events";
export {
  NOOP_REPLAY_SINK,
  NOOP_SPAN,
  NOOP_TRACE_CONTROL,
  NOOP_TRACER,
  assertTraceId,
  assertTraceName,
} from "./tracing/index";
export type {
  ReplayCorrelation,
  ReplayEventInput,
  ReplaySinkPort,
  SpanPort,
  TraceAttributes,
  TraceControlPort,
  TraceRunIdentity,
  TraceScalar,
  TraceSpanIdentity,
  TraceStatus,
  TraceTerminalState,
  TracerPort,
} from "./tracing/index";
export { sanitizeTracePayload } from "./security/index";
export type {
  ModelEvent,
  ModelRequest,
  ModelRequestOptions,
  ModelRuntimePort,
  ModelToolSpec,
  ToolInputConstraint,
  ToolConstraintCapability,
  ToolConstraintDecision,
  ToolConstraintReport,
  RuntimeModelSelection,
  ThinkingHistoryPolicy,
} from "./models";
export type {
  ModelCacheCapability,
  ModelCacheDirective,
  ModelCacheIntent,
  ModelCacheLeaseAdvice,
  ModelCacheLeaseAdvisorPort,
  ModelCacheLeaseStatus,
  ModelCacheLifecycle,
  ModelCacheMode,
  ModelCachePolicyDecision,
  ModelCachePolicyInput,
  ModelCachePolicyPort,
  ModelCacheReport,
  ModelCacheRetention,
  ModelCallIdentity,
} from "./models";
export { CommandRegistry } from "./commands/index";
export type {
  Command,
  CommandContext,
  CommandSelectionOptions,
  CommandSelectionResult,
  CommandInteractionPort,
} from "./commands/index";
export { createSkillsContributor } from "./system-prompt/index";
export type { SystemPromptContributor } from "./system-prompt/index";
export {
  composeStableSystemPrompt,
  assertPromptContributionBudget,
  PROMPT_CONTRIBUTION_BUDGETS,
  PromptContributionBudgetError,
} from "./system-prompt/index";
export { escapeMarkupText } from "./markup";
export {
  SKILL_FILE_NAME,
  SKILL_TOOL_NAME,
  SKILL_DIR_NAMES,
  SkillEventName,
  SkillEventNamespace,
  SkillDiagnosticCode,
  SkillDiagnosticType,
  SkillFrontmatterKeys,
  SkillLoader,
  SkillReadStatus,
  SkillRegistry,
  SkillRuntime,
  SkillReadLifecycleAdapter,
  SkillSourceScope,
  createSkillReadTool,
} from "./skills/index";
export type {
  LoadedSkill,
  SkillDiagnostic,
  SkillLoadResult,
  SkillLoaderOptions,
  SkillMetadata,
  SkillReadOptions,
  SkillReadResult,
  SkillRegistryOptions,
  SkillSlashPreload,
  SkillSource,
  SkillRuntimeOptions,
} from "./skills/index";
export { StreamSession, createStreamSession } from "./stream/index";
export { InterprocessFileLock } from "./persistence/index";
export type { InterprocessFileLockOptions } from "./persistence/index";
export type {
  StreamEvent,
  TextDeltaEvent,
  FinalResponseEvent,
  ModelContextPreparedEvent,
  StreamCallbacks,
  StreamState,
  AccumulatedMessage,
  ToolResultPayload,
} from "./stream/index";
export {
  AgentSessionRepository,
  AgentSessionNotFoundError,
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
} from "./session/index";
export type {
  AgentSession,
  AgentSessionRepositoryOptions,
  SessionEntry,
  SessionIndex,
  SessionRecord,
  SessionSnapshot,
} from "./session/index";
export { ContentBlockType, MessageRole } from "./messages";
export type {
  AssistantModelContextMessage,
  AssistantTranscriptMessage,
  DeferredModelResponse,
  ImageContent,
  ModelContextMessage,
  ModelDiagnostic,
  ModelUsage,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultModelContextMessage,
  ToolResultTranscriptMessage,
  TranscriptMessage,
  UserModelContextMessage,
  UserTranscriptMessage,
} from "./messages";
export {
  EnvironmentContextController,
  EnvironmentContextError,
  normalizeEnvironmentSnapshot,
  renderEnvironmentContext,
} from "./environment";
export type {
  EnvironmentCaptureResult,
  EnvironmentContextRecord,
  EnvironmentContextControllerPort,
  RuntimeEnvironmentProviderPort,
  RuntimeEnvironmentSnapshot,
  RuntimePlatform,
} from "./environment";
export { assertJsonObject, isJsonValue } from "./data";
export type { DeepReadonly, JsonValue } from "./data";
export { digestStableValue, serializeStableValue } from "./valueDigest";

export {
  InvalidRunDeadlineError,
  RunDeadline,
  RunDeadlineExceededError,
  assertRunDeadline,
} from "./execution/run-deadline";
export type { RunDeadlineSnapshot } from "./execution/run-deadline";

export type {
  CapturedOutputSource,
  OutputPart,
  OutputRecord,
  OutputReference,
  OutputReadRequest,
  OutputReadResult,
  OutputWriterPort,
  OutputPartWriterPort,
  SessionOutputPort,
  OutputCallContext,
  ToolOutputSource,
} from "./execution/output";

export { readTextPage, MAX_FILE_READ_OUTPUT_BYTES } from "./io/text-page-reader";
export type {
  StreamingReadRequest,
  StreamingReadResult,
  FilePagination,
} from "./io/text-page-reader";
export { createFileSnapshot, snapshotsEqual, snapshotVersion } from "./io/file-snapshot";
export type { FileSnapshot } from "./io/file-snapshot";
export { TextReadError } from "./io/text-read-error";
