import type {
  CommandInteractionPort,
  InteractionSurfacePort,
  AccessConsentBroker,
  ProcessExecutionRouterPort,
  ProcessExecutionPlannerPort,
  HostRuntimeContext,
  SkillSource,
  StreamCallbacks,
  TranscriptMessage,
} from "@omni-agent/core";
import type { ModelAuthInteraction } from "@omni-agent/app";

export interface CommandDescriptor {
  readonly name: string;
  readonly description: string;
}

export type HostTermination =
  | { readonly kind: "completed" }
  | { readonly kind: "user_interrupt" }
  | { readonly kind: "signal"; readonly signal: "SIGTERM" };

export interface SkillReadPresentationInput {
  readonly skillName: string;
  readonly status: "loaded" | "cached" | "failed";
  readonly source?: SkillSource;
  readonly filePath?: string;
  readonly tokenEstimate?: number;
  readonly durationMs?: number;
  readonly error?: string;
  readonly mode?: "inferred" | "explicit";
}

export interface RunPresentationSessionPort {
  callbacks(): StreamCallbacks;
  cancelPending(): void;
}

export interface AgentConsolePort {
  readonly interactionSurface: InteractionSurfacePort;
  readonly accessConsentBroker: AccessConsentBroker;
  readonly commandInteraction: CommandInteractionPort;

  start(): Promise<HostTermination>;
  terminate(termination: HostTermination): void;
  dispose(): void;
  bindHandlers(handlers: {
    onSubmit(input: string): void | Promise<void>;
    onInterrupt(): boolean;
  }): void;
  setCommandCatalog(commands: readonly CommandDescriptor[]): void;
  showWelcome(agent: { id: string; displayName?: string }): void;
  showSessionHistory(
    messages: readonly TranscriptMessage[],
    options: { initialTurns: number; agent: { id: string; displayName?: string } },
  ): void;
  clearSessionHistory(): void;
  appendUserMessage(text: string): void;
  writeNotice(text: string, tone?: "neutral" | "success" | "warning" | "error"): void;
  setStatus(status: { text: string; tone: "neutral" | "active" | "warning" | "error" }): void;
  setActivity(text: string | null): void;
  presentSkillRead(input: SkillReadPresentationInput): void;
  createRunPresentation(options?: { skills: boolean }): RunPresentationSessionPort;
}

export interface ProviderOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export type AuthenticationOption = ProviderOption;
export type ModelOption = ProviderOption;

export interface SelectionBehavior {
  readonly loop: boolean;
}

export interface ConfigurationSummary {
  readonly provider: string;
  readonly model: string;
  readonly credential: string;
}

export interface OnboardingInteractionPort {
  showWelcome(): void;
  selectProvider(options: readonly ProviderOption[]): Promise<string>;
  selectAuthenticationMethod(options: readonly AuthenticationOption[]): Promise<string>;
  selectModel(options: readonly ModelOption[], message?: string): Promise<string>;
  select(
    prompt: string,
    options: readonly ProviderOption[],
    behavior: SelectionBehavior,
  ): Promise<string>;
  input(options: {
    readonly message: string;
    readonly defaultValue?: string;
    readonly secret?: boolean;
    readonly validate?: (value: string) => true | string;
  }): Promise<string>;
  createAuthInteraction(): ModelAuthInteraction;
  showConfigurationReady(summary: ConfigurationSummary): void;
}

export interface CliHostServices {
  readonly runtime: CliRuntimeContext;
  readonly output: CliOutputPort;
  readonly text: TextPresentationPort;
  readonly processRouter: ProcessExecutionRouterPort;
  readonly processPlanner: ProcessExecutionPlannerPort;
  readonly hostRuntime: HostRuntimeContext;
  createAgentConsole(options: { workspaceRoot: string }): AgentConsolePort;
  createOnboardingInteraction(): OnboardingInteractionPort;
  runTracePreview(agentId: string): Promise<void>;
  confirm(message: string): Promise<boolean>;
}

export interface CliRuntimeContext {
  readonly cwd: string;
  readonly cliEntry: string;
  readonly globalDirectory: string;
  readonly agentPackagesDirectory: string;
  readonly nodeVersion: string;
}

export interface CliOutputPort {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliExecutionResult {
  readonly exitCode: number;
}

export interface TextPresentationPort {
  heading(text: string): string;
  accent(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
}
