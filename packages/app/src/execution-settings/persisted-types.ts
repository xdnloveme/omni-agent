import { isAbsolute } from "node:path";
import {
  normalizeNetworkTarget,
  type ExecutionMode,
  type FilesystemCapabilityScope,
  type NetworkTarget,
} from "@omni-agent/core";

export interface PersistedAgentExecutionSettings {
  readonly mode: ExecutionMode;
  readonly approvedNetworkTargets: readonly NetworkTarget[];
  readonly approvedFilesystemRoots: readonly FilesystemCapabilityScope[];
}

export interface PersistedExecutionSettings {
  readonly version: 6;
  readonly workspaces: Record<
    string,
    { readonly agents: Record<string, PersistedAgentExecutionSettings> }
  >;
}

export interface PersistedExecutionSettingsV4 {
  readonly version: 4;
  readonly workspaces: Record<
    string,
    {
      readonly agents: Record<
        string,
        { readonly mode: ExecutionMode; readonly controlledNetworkEnabled: boolean }
      >;
    }
  >;
}

export interface PersistedExecutionSettingsV5 {
  readonly version: 5;
  readonly workspaces: Record<
    string,
    {
      readonly agents: Record<
        string,
        {
          readonly mode: ExecutionMode;
          readonly controlledNetworkEnabled: boolean;
          readonly approvedFilesystemRoots: readonly FilesystemCapabilityScope[];
        }
      >;
    }
  >;
}

export const EMPTY_EXECUTION_SETTINGS: PersistedExecutionSettings = {
  version: 6,
  workspaces: {},
};

export function isPersistedExecutionSettings(value: unknown): value is PersistedExecutionSettings {
  return isExecutionSettings(value, 6, isAgentSettingsV6);
}

export function isPersistedExecutionSettingsV5(
  value: unknown,
): value is PersistedExecutionSettingsV5 {
  return isExecutionSettings(value, 5, isAgentSettingsV5);
}

export function isPersistedExecutionSettingsV4(
  value: unknown,
): value is PersistedExecutionSettingsV4 {
  return isExecutionSettings(value, 4, isAgentSettingsV4);
}

function isExecutionSettings(
  value: unknown,
  version: 4 | 5 | 6,
  isAgentSettings: (value: unknown) => boolean,
): boolean {
  if (!isRecord(value) || value.version !== version || !isRecord(value.workspaces)) return false;
  return Object.entries(value.workspaces).every(
    ([workspaceId, workspace]) =>
      /^[a-f0-9]{64}$/.test(workspaceId) &&
      isRecord(workspace) &&
      isRecord(workspace.agents) &&
      Object.values(workspace.agents).every(isAgentSettings),
  );
}

function isAgentSettingsV5(value: unknown): boolean {
  return (
    isAgentSettingsV4(value) &&
    Array.isArray((value as Record<string, unknown>).approvedFilesystemRoots) &&
    ((value as Record<string, unknown>).approvedFilesystemRoots as unknown[]).length <= 64 &&
    ((value as Record<string, unknown>).approvedFilesystemRoots as unknown[]).every(
      isFilesystemCapability,
    )
  );
}

function isAgentSettingsV6(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.mode === "controlled" || value.mode === "autonomous" || value.mode === "unrestricted") &&
    Array.isArray(value.approvedFilesystemRoots) &&
    value.approvedFilesystemRoots.length <= 64 &&
    value.approvedFilesystemRoots.every(isFilesystemCapability) &&
    Array.isArray(value.approvedNetworkTargets) &&
    value.approvedNetworkTargets.length <= 64 &&
    value.approvedNetworkTargets.every(isNetworkTarget)
  );
}

function isAgentSettingsV4(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.mode === "controlled" || value.mode === "autonomous" || value.mode === "unrestricted") &&
    typeof value.controlledNetworkEnabled === "boolean"
  );
}

function isFilesystemCapability(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    value.path.length <= 4096 &&
    isAbsolute(value.path) &&
    (value.scope === "exact" || value.scope === "subtree") &&
    (value.access === "read" || value.access === "read_write")
  );
}

function isNetworkTarget(value: unknown): boolean {
  if (!(
    isRecord(value) &&
    (value.scheme === "http" || value.scheme === "https") &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    value.host.length <= 253 &&
    Number.isInteger(value.port) &&
    (value.port as number) >= 1 &&
    (value.port as number) <= 65535
  ))
    return false;
  try {
    const normalized = normalizeNetworkTarget(value as unknown as NetworkTarget);
    return (
      normalized.scheme === value.scheme &&
      normalized.host === value.host &&
      normalized.port === value.port
    );
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
