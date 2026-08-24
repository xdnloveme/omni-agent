import type {
  ExecutionMode,
  HostRuntimeContext,
  ProcessAccessPlan,
  ProcessExecutableRequirement,
} from "../execution";
import type { RegisteredAgentTool, ToolResult } from "../types";

export interface WorkspaceExecutionSettings {
  readonly mode: ExecutionMode;
  readonly controlledNetworkEnabled: boolean;
  readonly approvedFilesystemRoots: readonly FilesystemCapabilityScope[];
}

export type AccessSensitivity = "ordinary" | "sensitive" | "protected";

export interface FilesystemCapabilityScope {
  readonly path: string;
  readonly scope: "exact" | "subtree";
  readonly access: "read" | "read_write";
}

export interface FilesystemConsentCandidate {
  readonly capability: FilesystemCapabilityScope;
  readonly sensitivity: AccessSensitivity;
}

export type AccessResource =
  | {
      readonly kind: "filesystem";
      readonly access: "read" | "write";
      readonly path: string;
      readonly scope: "exact" | "subtree";
      readonly location: "workspace" | "external";
      readonly sensitivity: AccessSensitivity;
    }
  | { readonly kind: "network" }
  | { readonly kind: "process" };

export interface ToolAccessIntent {
  readonly resources: readonly AccessResource[];
  readonly executableRequirements?: readonly ProcessExecutableRequirement[];
  readonly controlledConsentCandidates?: readonly FilesystemConsentCandidate[];
  /** Accesses observed by domain analysis but not covered by the tool's declared scope. */
  readonly uncoveredResources?: readonly AccessResource[];
  /** A domain or access-contract rejection that is not a security hard-stop. */
  readonly denial?: { readonly code: string; readonly reason: string };
  readonly hardStop?: { readonly code: string; readonly reason: string };
}

export interface ToolAccessContext {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly hostRuntime: HostRuntimeContext;
  readonly signal?: AbortSignal;
}

export type ToolAccessDescriptor =
  | { readonly kind: "internal"; readonly hiddenInputKeys?: readonly string[] }
  | {
      readonly kind: "dynamic";
      readonly hiddenInputKeys?: readonly string[];
      bindInput?(
        input: Record<string, unknown>,
        context: ToolAccessContext,
      ): Record<string, unknown> | Promise<Record<string, unknown>>;
      assess(
        input: Record<string, unknown>,
        context: ToolAccessContext,
      ): ToolAccessIntent | Promise<ToolAccessIntent>;
    };

export interface ToolAccessRequest {
  readonly tool: RegisteredAgentTool;
  readonly input: Record<string, unknown>;
  readonly context: ToolAccessContext;
}

export type ToolAccessResult =
  | {
      readonly outcome: "allowed";
      readonly grant: ToolAccessGrant;
      readonly accessMs: number;
    }
  | {
      readonly outcome: "denied";
      readonly result: ToolResult;
      readonly accessMs: number;
    };

export interface ToolAccessGrant {
  readonly input: Readonly<Record<string, unknown>>;
  readonly mode: ExecutionMode;
  readonly processAccess: ProcessAccessPlan;
  readonly executableRequirements: readonly ProcessExecutableRequirement[];
}

export interface ExecutionSettingsPort {
  getSettings(workspaceId: string, agentId: string): Promise<WorkspaceExecutionSettings>;
  enableControlledNetwork(workspaceId: string, agentId: string): Promise<void>;
  addApprovedFilesystemRoots(
    workspaceId: string,
    agentId: string,
    roots: readonly FilesystemCapabilityScope[],
  ): Promise<void>;
}
