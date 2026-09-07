import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type FetchLike,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import {
  redactExactSensitiveError,
  redactExactSensitiveValue,
  throwIfAborted,
  type AuthorizedNetworkClient,
  type ToolExecutionContext,
  type ToolResult,
} from "@omni-agent/core";
import type { McpCredentialStore } from "../credentials/credential-store";
import {
  MCP_PROTOCOL_REVISION,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpStdioServerConfig,
} from "../config/types";
import { mapMcpToolResult } from "./content-mapper";
import {
  KeychainMcpOAuthProvider,
  type McpOAuthInteractionPort,
} from "../auth/keychain-oauth-provider";

const MCP_MAX_TRANSPORT_BYTES = 2 * 1024 * 1024;
export interface McpServerSnapshot {
  readonly tools: readonly Tool[];
  readonly instructions?: string;
}

export class McpSdkClient {
  private readonly stdioClients = new Map<string, Promise<Client>>();
  constructor(
    private readonly credentials: McpCredentialStore,
    private readonly environment: Readonly<Record<string, string | undefined>> = {},
    private readonly oauthInteraction?: McpOAuthInteractionPort,
  ) {}

  async discover(
    config: McpServerConfig,
    signal?: AbortSignal,
    network?: AuthorizedNetworkClient,
  ): Promise<McpServerSnapshot> {
    if (config.transport === "stdio")
      return readSnapshot(await this.stdioClient(config, signal, true), signal);
    if (!network) throw new Error("Authorized MCP network client is unavailable");
    return this.withClient(config, network, signal, (client) => readSnapshot(client, signal));
  }

  async call(
    config: McpServerConfig,
    tool: Tool,
    input: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const network = config.transport === "streamable_http" ? context.network : undefined;
    if (config.transport === "streamable_http" && !network)
      return {
        content: [{ type: "text", text: "Authorized MCP network client is unavailable." }],
        isError: true,
        meta: { code: "network_runtime_unavailable" },
      };
    const invoke = async (client: Client) =>
      mapMcpToolResult(
        await client.callTool(
          { name: tool.name, arguments: { ...input } },
          { signal: context.signal, toolDefinition: tool },
        ),
        config.id,
      );
    if (config.transport === "stdio") return invoke(await this.stdioClient(config, context.signal));
    return this.withClient(config, network!, context.signal, invoke, false);
  }

  async close(serverId: string): Promise<void> {
    const pending = this.stdioClients.get(serverId);
    if (!pending) return;
    this.stdioClients.delete(serverId);
    const client = await pending.catch(() => undefined);
    await client?.close();
  }

  private async stdioClient(
    config: McpStdioServerConfig,
    signal?: AbortSignal,
    activate = false,
  ): Promise<Client> {
    throwIfAborted(signal);
    const existing = this.stdioClients.get(config.id);
    if (existing) return existing;
    const allowed = new Set(config.inheritEnvironment ?? []);
    const implicit = DEFAULT_INHERITED_ENV_VARS.filter((name) => !allowed.has(name));
    // The SDK merges defaults even when env is provided. Never silently widen the allowlist.
    if (implicit.length > 0)
      throw Object.assign(
        new Error(
          `MCP SDK inherits default environment variables; explicitly include ${implicit.join(", ")} in inheritEnvironment or use HTTP`,
        ),
        {
          code: "mcp_stdio_environment_not_authorized",
        },
      );
    if (!activate)
      throw Object.assign(
        new Error(`MCP ${config.id} disconnected; retry activation through /mcp`),
        {
          code: "mcp_server_disconnected",
        },
      );
    const client = createSdkClient();
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      ...(config.cwd ? { cwd: config.cwd } : {}),
      env: selectEnvironment(config.inheritEnvironment ?? [], this.environment),
      // The SDK also probes a sibling process. Ignore stderr for both: an unread
      // pipe can deadlock a chatty server, and raw integration logs may contain secrets.
      stderr: "ignore",
      maxBufferSize: MCP_MAX_TRANSPORT_BYTES,
    });
    const pending = (async () => {
      try {
        await client.connect(transport, { signal });
        assertProtocolRevision(client);
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    })();
    this.stdioClients.set(config.id, pending);
    client.onclose = () => {
      if (this.stdioClients.get(config.id) === pending) this.stdioClients.delete(config.id);
    };
    return pending;
  }

  async finishAuthorization(
    config: McpHttpServerConfig,
    callbackUrl: string,
    network: AuthorizedNetworkClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const provider = this.oauthProvider(config);
    let sensitiveValues = mergeSensitiveValues(await provider.sensitiveValues(), [callbackUrl]);
    try {
      const callback = new URL(callbackUrl);
      const redirect = config.oauth ? new URL(config.oauth.redirectUrl) : undefined;
      if (
        !redirect ||
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        callback.username ||
        callback.password
      )
        throw Object.assign(new Error("MCP OAuth callback URL does not match configuration"), {
          code: "mcp_oauth_callback_mismatch",
        });
      sensitiveValues = mergeSensitiveValues(sensitiveValues, [...callback.searchParams.values()]);
      throwIfAborted(signal);
      await provider.validateCallbackState(callback.searchParams.get("state"));
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: gatewayFetch(network, signal),
        authProvider: provider,
        onInsufficientScope: "throw",
      });
      try {
        await transport.finishAuth(callback.searchParams);
        await provider.invalidateCredentials("verifier");
      } finally {
        await transport.close();
      }
    } catch (error) {
      sensitiveValues = mergeSensitiveValues(sensitiveValues, await provider.sensitiveValues());
      const sanitized = redactExactSensitiveError(error, { exactValues: sensitiveValues });
      if (!(sanitized instanceof Error)) throw sanitized;
      if (!("code" in sanitized && typeof sanitized.code === "string")) {
        Object.assign(sanitized, { code: "mcp_oauth_completion_failed" });
      }
      throw sanitized;
    }
  }

  private async withClient<T>(
    config: McpHttpServerConfig,
    network: AuthorizedNetworkClient,
    signal: AbortSignal | undefined,
    operation: (client: Client) => Promise<T>,
    allowAuthorization = true,
  ): Promise<T> {
    const sensitiveValues = [...(await this.collectSensitiveValues(config))];
    try {
      const result = await this.useHttpClient(
        config,
        network,
        signal,
        operation,
        allowAuthorization,
        sensitiveValues,
      );
      sensitiveValues.push(...(await this.collectSensitiveValues(config)));
      return redactExactSensitiveValue(result, { exactValues: sensitiveValues }) as T;
    } catch (error) {
      sensitiveValues.push(...(await this.collectSensitiveValues(config)));
      throw redactExactSensitiveError(error, { exactValues: sensitiveValues });
    }
  }

  private async useHttpClient<T>(
    config: McpHttpServerConfig,
    network: AuthorizedNetworkClient,
    signal: AbortSignal | undefined,
    operation: (client: Client) => Promise<T>,
    allowAuthorization: boolean,
    sensitiveValues: string[],
  ): Promise<T> {
    let authorizationUrl: URL | undefined;
    const client = createSdkClient();
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      fetch: gatewayFetch(network, signal),
      ...(config.oauth
        ? {
            authProvider: this.oauthProvider(config, (url) => {
              authorizationUrl = url;
            }),
          }
        : config.bearerCredentialId
          ? {
              authProvider: { token: () => this.credentials.get(config.bearerCredentialId!) },
            }
          : {}),
      onInsufficientScope: "throw",
    });
    try {
      await client.connect(transport, { signal });
      assertProtocolRevision(client);
      return await operation(client);
    } catch (error) {
      if (!allowAuthorization && error instanceof UnauthorizedError && authorizationUrl)
        throw Object.assign(
          new Error(`MCP ${config.id} requires authorization; retry activation through /mcp`),
          {
            code: "mcp_authorization_required",
          },
        );
      if (
        allowAuthorization &&
        error instanceof UnauthorizedError &&
        authorizationUrl &&
        config.oauth
      ) {
        if (!this.oauthInteraction)
          throw Object.assign(new Error(`MCP OAuth interaction is unavailable for ${config.id}`), {
            code: "mcp_oauth_interaction_unavailable",
          });
        throwIfAborted(signal);
        const callback = await this.oauthInteraction.requestAuthorizationCallback(
          config.id,
          authorizationUrl,
          signal,
        );
        // Keep round-trip secrets until this call settles, even after Keychain cleanup.
        sensitiveValues.push(callback, ...(await this.collectSensitiveValues(config)));
        if (URL.canParse(callback))
          sensitiveValues.push(...new URL(callback).searchParams.values());
        throwIfAborted(signal);
        await this.finishAuthorization(config, callback, network, signal);
        // Continue once after explicit authorization-required; never retry arbitrary failures.
        return this.withClient(config, network, signal, operation, false);
      }
      throw error;
    } finally {
      try {
        if (authorizationUrl) {
          const provider = this.oauthProvider(config);
          sensitiveValues.push(...(await provider.sensitiveValues()));
          await provider.clearAuthorizationAttempt();
        }
      } finally {
        await client.close();
      }
    }
  }

  private async collectSensitiveValues(config: McpServerConfig): Promise<readonly string[]> {
    if (config.transport !== "streamable_http") return [];
    const bearer = config.bearerCredentialId
      ? await this.credentials.get(config.bearerCredentialId)
      : undefined;
    const oauth = config.oauth ? await this.oauthProvider(config).sensitiveValues() : [];
    return mergeSensitiveValues(bearer ? [bearer] : [], oauth);
  }

  private oauthProvider(
    config: McpHttpServerConfig,
    onRedirect?: (url: URL) => void,
  ): KeychainMcpOAuthProvider {
    return new KeychainMcpOAuthProvider(config, this.credentials, {
      redirectToAuthorization: (_serverId, url) => {
        if (!onRedirect) throw new Error("Unexpected MCP OAuth redirect");
        onRedirect(url);
      },
    });
  }
}

function createSdkClient(): Client {
  return new Client(
    { name: "omni-agent", version: "0.0.1" },
    {
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_REVISION } },
      inputRequired: { autoFulfill: false },
    },
  );
}

function assertProtocolRevision(client: Client): void {
  if (
    client.getNegotiatedProtocolVersion() !== MCP_PROTOCOL_REVISION ||
    client.getProtocolEra() !== "modern"
  )
    throw Object.assign(new Error("MCP server did not negotiate the required protocol revision"), {
      code: "mcp_protocol_mismatch",
    });
}

function mergeSensitiveValues(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat().filter((value) => value.length > 0))];
}

async function readSnapshot(client: Client, signal?: AbortSignal): Promise<McpServerSnapshot> {
  const { tools } = await client.listTools(undefined, { cacheMode: "refresh", signal });
  const instructions = client.getInstructions();
  return { tools, ...(instructions ? { instructions } : {}) };
}

function gatewayFetch(client: AuthorizedNetworkClient, signal?: AbortSignal): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    if (body && body.byteLength > MCP_MAX_TRANSPORT_BYTES)
      throw new Error("MCP request body exceeds limit");
    if (request.method !== "GET" && request.method !== "POST")
      throw new Error("Unsupported MCP HTTP method");
    const response = await client.requestStream({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      ...(body ? { body } : {}),
      maxCompressedBytes: MCP_MAX_TRANSPORT_BYTES,
      maxDecompressedBytes: MCP_MAX_TRANSPORT_BYTES,
      signal: signal ? AbortSignal.any([signal, request.signal]) : request.signal,
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

function selectEnvironment(
  names: readonly string[],
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`Invalid MCP environment key: ${name}`);
    // Override SDK defaults with the immutable host snapshot, including absent values.
    selected[name] = source[name] ?? "";
  }
  return selected;
}
