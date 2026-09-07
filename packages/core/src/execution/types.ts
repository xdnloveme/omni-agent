import type { ProcessToolDefinition, RegisteredAgentTool, ToolResult } from "../types";
import type { AuthorizedNetworkClient, NetworkCapability, NetworkProxyRoute } from "../network";
import type { SensitiveValueSet } from "../security";

export type ExecutionMode = "controlled" | "autonomous" | "unrestricted";

export interface HostRuntimeContext {
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

export interface ProcessExecutableRequirement {
  readonly kind: "host_command";
  readonly command: string;
  readonly cwd: string | "unknown";
  readonly origin: "shell_command";
}

export interface ToolExecutionContext {
  cwd: string;
  signal?: AbortSignal;
  network?: AuthorizedNetworkClient;
}

export type ToolExecutionStrategy = { kind: "in_process" } | { kind: "process" };

export interface SandboxPathScope {
  readonly path: string;
  readonly scope: "exact" | "subtree";
}

export interface SandboxPolicy {
  readonly mode: "controlled" | "autonomous";
  readonly workspaceRoot: string;
  readonly network:
    | { readonly kind: "disabled" }
    | { readonly kind: "loopback_proxy"; readonly host: "127.0.0.1"; readonly port: number };
  readonly read: readonly SandboxPathScope[];
  readonly write: readonly SandboxPathScope[];
  readonly protectedWriteRoots: readonly string[];
}

export type ProcessAccessPlan =
  | { readonly route: "host" }
  | {
      readonly route: "sandbox";
      readonly policy: SandboxPolicy;
    };

export type ProcessExecutionPlan =
  | { readonly route: "host"; readonly invocation: ProcessInvocation }
  | {
      readonly route: "sandbox";
      readonly invocation: ProcessInvocation;
      readonly policy: SandboxPolicy;
      readonly runtimeRead: readonly SandboxPathScope[];
    };

export interface ToolExecutionPlan {
  readonly mode: ExecutionMode;
  readonly process?: ProcessExecutionPlan;
  readonly network?: NetworkCapability;
  readonly sensitiveValues?: SensitiveValueSet;
}

export interface AuthorizedExecutionContext extends ToolExecutionContext {
  toolName: string;
  input: Readonly<Record<string, unknown>>;
}

declare const authorizedToolCallBrand: unique symbol;

export interface AuthorizedToolCall {
  readonly [authorizedToolCallBrand]: true;
  readonly tool: RegisteredAgentTool;
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: ToolExecutionContext;
  readonly executionPlan: ToolExecutionPlan;
}

export interface ToolInvocationResult {
  result: ToolResult;
  executionMs: number;
}

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes: number;
  readonly sensitiveValues?: SensitiveValueSet;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ProcessExecutionRouterPort {
  run(plan: ProcessExecutionPlan, signal?: AbortSignal): Promise<ProcessResult>;
}

export interface ProcessExecutionPlanningRequest {
  readonly tool: ProcessToolDefinition;
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: ToolExecutionContext;
  readonly access: ProcessAccessPlan;
  readonly executableRequirements: readonly ProcessExecutableRequirement[];
  readonly networkProxy?: NetworkProxyRoute;
  readonly sensitiveValues?: SensitiveValueSet;
}

export interface ProcessExecutionPlannerPort {
  prepare(request: ProcessExecutionPlanningRequest): Promise<ProcessExecutionPlan>;
}
