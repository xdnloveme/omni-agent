export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

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

export function validateMcpServerConfigs(configs: readonly McpServerConfig[]): void {
  if (configs.length > MAX_MCP_SERVERS) throw new Error("MCP server limit exceeded");
  const ids = new Set<string>();
  for (const config of configs) {
    if ("enabled" in config)
      throw new Error("MCP activation is managed with /mcp, not a configuration enabled field");
    if (!isMcpServerId(config.id)) throw new Error(`Invalid MCP server id: ${config.id}`);
    const normalized = normalizeMcpName(config.id);
    if (ids.has(normalized)) throw new Error(`MCP server id collision: ${config.id}`);
    ids.add(normalized);
    if (config.transport === "streamable_http") {
      const url = new URL(config.url);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error(`MCP HTTP server must use HTTP or HTTPS: ${config.id}`);
      if (url.username || url.password)
        throw new Error(`MCP server URL contains credentials: ${config.id}`);
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
    } else if (!config.command.trim())
      throw new Error(`MCP stdio command is required: ${config.id}`);
  }
}

function validateHttpUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${label} must use HTTP or HTTPS`);
  if (url.username || url.password) throw new Error(`${label} contains credentials`);
  return url;
}

export function normalizeMcpName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) throw new Error(`MCP name cannot be normalized: ${value}`);
  return normalized;
}
