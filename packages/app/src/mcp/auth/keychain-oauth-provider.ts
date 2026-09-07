import { randomUUID } from "node:crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { McpHttpServerConfig } from "../config/types";
import type { McpCredentialStore } from "../credentials/credential-store";

export interface McpOAuthInteractionPort {
  requestAuthorizationCallback(serverId: string, url: URL, signal?: AbortSignal): Promise<string>;
}

interface McpAuthorizationRedirect {
  redirectToAuthorization(serverId: string, url: URL): void | Promise<void>;
}

/** Persists redirect-round-trip material in the Keychain-backed MCP credential store. */
export class KeychainMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;
  readonly #prefix: string;

  constructor(
    private readonly config: McpHttpServerConfig,
    private readonly credentials: McpCredentialStore,
    private readonly interaction: McpAuthorizationRedirect,
  ) {
    if (!config.oauth) throw new Error(`OAuth is not configured for MCP server ${config.id}`);
    this.redirectUrl = new URL(config.oauth.redirectUrl);
    this.#prefix = `oauth:${config.oauth.credentialId}`;
    this.clientMetadata = {
      client_name: config.oauth.clientName ?? "Omni Agent",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(config.oauth.scopes?.length ? { scope: config.oauth.scopes.join(" ") } : {}),
    };
  }

  async state(): Promise<string> {
    const value = randomUUID();
    await this.credentials.set(this.key("state"), value);
    return value;
  }
  clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    return this.read("client", issuer(context));
  }
  saveClientInformation(
    value: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    return this.saveIssuerCredential("client", value, issuer(context));
  }
  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const issuerValue = issuer(context);
    if (issuerValue) return this.read("tokens", issuerValue, false);
    const latestIssuer = await this.credentials.get(this.key("tokens-latest-issuer"));
    return latestIssuer ? this.read("tokens", latestIssuer, false) : this.read("tokens");
  }
  async saveTokens(
    value: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.saveIssuerCredential("tokens", value, issuer(context));
  }
  redirectToAuthorization(url: URL): void | Promise<void> {
    return this.interaction.redirectToAuthorization(this.config.id, url);
  }
  saveCodeVerifier(value: string): Promise<void> {
    return this.credentials.set(this.key("verifier"), value);
  }
  async codeVerifier(): Promise<string> {
    const value = await this.credentials.get(this.key("verifier"));
    if (!value)
      throw Object.assign(new Error("MCP OAuth verifier is unavailable"), {
        code: "mcp_oauth_state_missing",
      });
    return value;
  }
  saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    return this.write("discovery", value);
  }
  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.read("discovery");
  }
  async validateCallbackState(value: string | null): Promise<void> {
    const expected = await this.credentials.get(this.key("state"));
    if (!value || !expected || value !== expected)
      throw Object.assign(new Error("MCP OAuth state mismatch"), {
        code: "mcp_oauth_state_mismatch",
      });
    await this.credentials.delete(this.key("state"));
  }
  async sensitiveValues(): Promise<readonly string[]> {
    const [tokens, verifier, state] = await Promise.all([
      this.tokens(),
      this.credentials.get(this.key("verifier")),
      this.credentials.get(this.key("state")),
    ]);
    return [
      tokens?.access_token,
      tokens?.refresh_token,
      "id_token" in (tokens ?? {}) ? (tokens as Record<string, unknown>).id_token : undefined,
      verifier,
      state,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
  }

  async clearAuthorizationAttempt(): Promise<void> {
    await Promise.all([
      this.credentials.delete(this.key("state")),
      this.credentials.delete(this.key("verifier")),
    ]);
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const names =
      scope === "all" ? ["client", "tokens", "verifier", "discovery", "state"] : [scope];
    await Promise.all(
      names.map((name) =>
        name === "tokens" || name === "client"
          ? this.deleteIssuerCredential(name)
          : this.credentials.delete(this.key(name)),
      ),
    );
  }

  private key(name: string, issuerValue?: string): string {
    return `${this.#prefix}:${name}${issuerValue ? `:${encodeURIComponent(issuerValue)}` : ""}`;
  }
  private async read<T>(
    name: string,
    issuerValue?: string,
    fallback = true,
  ): Promise<T | undefined> {
    const raw =
      (await this.credentials.get(this.key(name, issuerValue))) ??
      (issuerValue && fallback ? await this.credentials.get(this.key(name)) : undefined);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw Object.assign(new Error(`Stored MCP OAuth ${name} is invalid`), {
        code: "mcp_oauth_credentials_invalid",
      });
    }
  }
  private write(name: string, value: unknown, issuerValue?: string): Promise<void> {
    return this.credentials.set(this.key(name, issuerValue), JSON.stringify(value));
  }
  private async saveIssuerCredential(
    name: "client" | "tokens",
    value: unknown,
    issuerValue?: string,
  ): Promise<void> {
    const index = this.key(`${name}-latest-issuer`);
    const previousIssuer = await this.credentials.get(index);
    if (previousIssuer && previousIssuer !== issuerValue)
      await this.credentials.delete(this.key(name, previousIssuer));
    // Publish the cleanup target before the credential, so partial writes remain reclaimable.
    if (issuerValue) {
      await this.credentials.set(index, issuerValue);
      await this.credentials.delete(this.key(name));
    } else await this.credentials.delete(index);
    await this.write(name, value, issuerValue);
  }
  private async deleteIssuerCredential(name: "client" | "tokens"): Promise<void> {
    const index = this.key(`${name}-latest-issuer`);
    const latestIssuer = await this.credentials.get(index);
    await Promise.all([
      this.credentials.delete(this.key(name)),
      ...(latestIssuer ? [this.credentials.delete(this.key(name, latestIssuer))] : []),
    ]);
    await this.credentials.delete(index);
  }
}

function issuer(context?: OAuthClientInformationContext): string | undefined {
  return context?.issuer ? String(context.issuer) : undefined;
}
