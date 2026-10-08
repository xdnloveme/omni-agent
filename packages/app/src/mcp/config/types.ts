import { containsSecretField } from "@omni-agent/models";

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export interface McpConfigDiagnostic {
  readonly source: "global" | "project";
  readonly index?: number;
  readonly serverId?: string;
  readonly message: string;
}

export interface ResolvedMcpConfiguration {
  readonly servers: readonly McpServerConfig[];
  readonly diagnostics: readonly McpConfigDiagnostic[];
}

interface McpServerConfigBase {
  readonly id: string;
}
export interface McpHttpServerConfig extends McpServerConfigBase {
  readonly transport: "streamable_http";
  readonly url: string;
  readonly bearerCredentialId?: string;
  /** OAuth discovery endpoints are separate exact capabilities, never derived grants. */
  readonly oauthTargets?: readonly string[];
  readonly oauth?: {
    readonly credentialId: string;
    readonly redirectUrl: string;
    readonly clientName?: string;
    readonly scopes?: readonly string[];
  };
}
export interface McpStdioServerConfig extends McpServerConfigBase {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly inheritEnvironment?: readonly string[];
}
export const MCP_PROTOCOL_REVISION = "2026-07-28";
export const MAX_MCP_SERVERS = 16;

export function isMcpServerId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
}

export function parseMcpConfiguration(
  value: unknown,
  source: McpConfigDiagnostic["source"],
): ResolvedMcpConfiguration {
  if (value === undefined) return { servers: [], diagnostics: [] };
  if (!isRecord(value) || !Array.isArray(value.servers))
    return { servers: [], diagnostics: [{ source, message: "MCP servers must be an array" }] };
  if (value.servers.length > MAX_MCP_SERVERS)
    return { servers: [], diagnostics: [{ source, message: "MCP server limit exceeded" }] };
  const counts = new Map<string, number>();
  for (const entry of value.servers) {
    if (isRecord(entry) && isMcpServerId(entry.id)) {
      const key = normalizeMcpName(entry.id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const servers: McpServerConfig[] = [];
  const diagnostics: McpConfigDiagnostic[] = [];
  for (const [index, entry] of value.servers.entries()) {
    const serverId = isRecord(entry) && isMcpServerId(entry.id) ? entry.id : undefined;
    try {
      if (!serverId) throw new Error("Invalid or missing MCP server id");
      if (counts.get(normalizeMcpName(serverId))! > 1) throw new Error("MCP server id collision");
      validateMcpServerConfig(entry);
      servers.push(structuredClone(entry));
    } catch (error) {
      diagnostics.push({
        source,
        index,
        ...(serverId ? { serverId } : {}),
        message: error instanceof Error ? error.message : "Invalid MCP server configuration",
      });
    }
  }
  return { servers, diagnostics };
}

function validateMcpServerConfig(value: unknown): asserts value is McpServerConfig {
  if (!isRecord(value)) throw new Error("MCP server must be an object");
  if (containsMcpSecrets({ servers: [value] }))
    throw new Error("MCP secrets must be stored in Keychain");
  if (value.transport !== "stdio" && value.transport !== "streamable_http")
    throw new Error("Invalid MCP transport");
  for (const key of ["args", "inheritEnvironment", "oauthTargets"])
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) || !value[key].every((item: unknown) => typeof item === "string"))
    )
      throw new Error(`MCP ${key} must be an array of strings`);
  for (const key of ["cwd", "bearerCredentialId"])
    if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key].trim()))
      throw new Error(`Invalid MCP ${key}`);
  if (value.oauth !== undefined) {
    if (
      !isRecord(value.oauth) ||
      typeof value.oauth.credentialId !== "string" ||
      typeof value.oauth.redirectUrl !== "string" ||
      (value.oauth.clientName !== undefined && typeof value.oauth.clientName !== "string") ||
      (value.oauth.scopes !== undefined &&
        (!Array.isArray(value.oauth.scopes) ||
          !value.oauth.scopes.every((item: unknown) => typeof item === "string")))
    )
      throw new Error("Invalid MCP OAuth configuration");
  }
  const config = value as unknown as McpServerConfig;
  if ("enabled" in config)
    throw new Error("MCP activation is managed with /mcp, not a configuration enabled field");
  if (config.transport === "streamable_http") {
    validateHttpUrl(config.url, `MCP server URL for ${config.id}`);
    if (config.bearerCredentialId && config.oauth)
      throw new Error(
        `MCP server cannot configure bearer and OAuth credentials together: ${config.id}`,
      );
    for (const target of config.oauthTargets ?? [])
      validateHttpUrl(target, `MCP OAuth target for ${config.id}`);
    if (config.oauth) {
      if (!config.oauth.credentialId.trim())
        throw new Error(`MCP OAuth credential id is required: ${config.id}`);
      const redirect = validateHttpUrl(
        config.oauth.redirectUrl,
        `MCP OAuth redirect for ${config.id}`,
      );
      if (
        redirect.hostname !== "127.0.0.1" &&
        redirect.hostname !== "localhost" &&
        redirect.protocol !== "https:"
      )
        throw new Error(`MCP OAuth redirect must be HTTPS or loopback: ${config.id}`);
    }
  } else if (typeof config.command !== "string" || !config.command.trim())
    throw new Error(`MCP stdio command is required: ${config.id}`);
}

function validateHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${label} must use HTTP or HTTPS`);
  if (url.username || url.password) throw new Error(`${label} contains credentials`);
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keychain reference names are configuration, not embedded credential values. */
export function containsMcpSecrets(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.servers)) return containsSecretField(value);
  return containsSecretField({
    ...value,
    servers: value.servers.map((entry) => {
      if (!isRecord(entry)) return entry;
      const { bearerCredentialId, oauth, ...rest } = entry;
      const server = {
        ...rest,
        ...(bearerCredentialId === undefined || typeof bearerCredentialId === "string"
          ? {}
          : { bearerCredentialId }),
      };
      if (!isRecord(oauth)) return { ...server, oauth };
      const { credentialId, ...oauthFields } = oauth;
      return {
        ...server,
        oauth: {
          ...oauthFields,
          ...(credentialId === undefined || typeof credentialId === "string"
            ? {}
            : { credentialId }),
        },
      };
    }),
  });
}

export function normalizeMcpName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) throw new Error(`MCP name cannot be normalized: ${value}`);
  return normalized;
}
