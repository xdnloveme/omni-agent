import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/client/stdio";
import type { AuthorizedNetworkClient, NetworkRequest } from "@omni-agent/core";
import { McpSdkClient } from "../mcp/client/sdk-client";
import { McpCatalogService } from "../mcp/catalog/mcp-catalog-service";
import { ToolRegistry } from "../registry/tool-registry";
import { InMemoryMcpCredentialStore } from "../mcp/credentials/credential-store";
import type { McpHttpServerConfig, McpStdioServerConfig } from "../mcp/config/types";

const counter = { name: "counter", inputSchema: { type: "object" as const } };

describe("MCP SDK integration lifecycle", () => {
  it("preserves stdio state across discovery, concurrent calls and cancellation; closes on disable", async () => {
    const config: McpStdioServerConfig = {
      id: "stateful",
      transport: "stdio",
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/stateful-mcp-server.mjs", import.meta.url))],
      inheritEnvironment: [...DEFAULT_INHERITED_ENV_VARS],
    };
    const client = new McpSdkClient(new InMemoryMcpCredentialStore(), process.env);
    const catalog = new McpCatalogService(new ToolRegistry(), client);
    const call = async (input: Record<string, unknown> = {}, signal?: AbortSignal) => {
      const result = await client.call(config, counter, input, { cwd: process.cwd(), signal });
      const text = result.content.find((entry) => entry.type === "text")?.text;
      return JSON.parse(text!) as { count: number; pid: number };
    };
    try {
      await catalog.refresh(config);
      const first = await call();
      await catalog.refresh(config);
      const next = await Promise.all([call(), call()]);
      expect(next.map((value) => value.count).sort()).toEqual([2, 3]);
      expect(next.every((value) => value.pid === first.pid)).toBe(true);
      const abort = new AbortController();
      const waiting = call({ wait: true }, abort.signal);
      abort.abort();
      await expect(waiting).rejects.toThrow();
      expect(await call()).toEqual({ count: 4, pid: first.pid });
      await catalog.deactivate(config.id);
      expect(catalog.tools()).toEqual([]);
      await expect(call()).rejects.toMatchObject({ code: "mcp_server_disconnected" });
      await catalog.refresh(config);
      const restarted = await call();
      expect(restarted.count).toBe(1);
      expect(restarted.pid).not.toBe(first.pid);
    } finally {
      await client.close(config.id);
    }
  });

  it("completes OAuth through the host callback and authorized gateway, without leaking tokens", async () => {
    const config: McpHttpServerConfig = {
      id: "remote",
      transport: "streamable_http",
      url: "https://mcp.example/mcp",
      oauthTargets: ["https://auth.example"],
      oauth: { credentialId: "remote", redirectUrl: "http://127.0.0.1:48100/callback" },
    };
    let prompts = 0;
    let exchanges = 0;
    const authorizationCode = "test-authorization-secret";
    const accessToken = "test-access-secret";
    const visited: string[] = [];
    const network: AuthorizedNetworkClient = {
      request: async () => {
        throw new Error("Unexpected buffered request");
      },
      requestStream: async (request: NetworkRequest) => {
        visited.push(request.url);
        let result: unknown;
        let status = 200;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (request.url.includes("/.well-known/oauth-protected-resource")) {
          result = { resource: config.url, authorization_servers: ["https://auth.example"] };
        } else if (request.url.includes("/.well-known/")) {
          result = {
            issuer: "https://auth.example",
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            registration_endpoint: "https://auth.example/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          };
        } else if (request.url === "https://auth.example/register") {
          result = {
            ...JSON.parse(new TextDecoder().decode(request.body)),
            client_id: "omni-test",
          };
        } else if (request.url === "https://auth.example/token") {
          const form = new URLSearchParams(new TextDecoder().decode(request.body));
          expect(form.get("code")).toBe(authorizationCode);
          expect(form.get("code_verifier")).toBeTruthy();
          exchanges += 1;
          result = { access_token: accessToken, token_type: "Bearer" };
        } else if (request.headers?.authorization !== `Bearer ${accessToken}`) {
          status = 401;
          headers["www-authenticate"] =
            'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"';
          result = {};
        } else {
          const rpc = JSON.parse(new TextDecoder().decode(request.body));
          result = {
            jsonrpc: "2.0",
            id: rpc.id,
            result:
              rpc.method === "server/discover"
                ? {
                    supportedVersions: ["2026-07-28"],
                    capabilities: { tools: {} },
                    instructions: `${accessToken} ${authorizationCode}`,
                  }
                : {
                    resultType: "complete",
                    ttlMs: 0,
                    cacheScope: "private",
                    tools: [counter],
                    instructions: accessToken,
                  },
          };
        }
        return {
          requestedUrl: request.url,
          finalUrl: request.url,
          status,
          headers,
          redirectCount: 0,
          body: new Response(JSON.stringify(result)).body!,
        };
      },
    };
    const client = new McpSdkClient(
      new InMemoryMcpCredentialStore(),
      {},
      {
        async requestAuthorizationCallback(_id, url) {
          prompts += 1;
          expect(url.origin).toBe("https://auth.example");
          return `${config.oauth!.redirectUrl}?code=${authorizationCode}&state=${url.searchParams.get("state")}`;
        },
      },
    );
    const snapshot = await client.discover(config, undefined, network);
    expect(snapshot.tools).toEqual([counter]);
    expect(snapshot.instructions).toBeTruthy();
    expect(JSON.stringify(snapshot)).not.toContain(accessToken);
    expect(JSON.stringify(snapshot)).not.toContain(authorizationCode);
    expect(prompts).toBe(1);
    expect(exchanges).toBe(1);
    expect(visited).toContain("https://auth.example/token");
    await client.discover(config, undefined, network);
    expect(prompts).toBe(1);

    const rejected = new McpSdkClient(
      new InMemoryMcpCredentialStore(),
      {},
      {
        requestAuthorizationCallback: async () =>
          `${config.oauth!.redirectUrl}?code=${authorizationCode}&state=wrong`,
      },
    );
    await expect(rejected.discover(config, undefined, network)).rejects.toMatchObject({
      code: "mcp_oauth_state_mismatch",
    });
    expect(exchanges).toBe(1);

    const abort = new AbortController();
    const cancelledCredentials = new InMemoryMcpCredentialStore();
    const cancelled = new McpSdkClient(
      cancelledCredentials,
      {},
      {
        async requestAuthorizationCallback(_id, url) {
          abort.abort();
          return `${config.oauth!.redirectUrl}?code=${authorizationCode}&state=${url.searchParams.get("state")}`;
        },
      },
    );
    await expect(cancelled.discover(config, abort.signal, network)).rejects.toThrow();
    expect(await cancelledCredentials.get("oauth:remote:state")).toBeUndefined();
    expect(await cancelledCredentials.get("oauth:remote:verifier")).toBeUndefined();
    expect(exchanges).toBe(1);
    const invalidCallback = "invalid-callback-secret";
    const invalidError = await client
      .finishAuthorization(config, invalidCallback, network)
      .catch((error) => error);
    expect(
      `${invalidError.message} ${invalidError.stack} ${JSON.stringify(invalidError)}`,
    ).not.toContain(invalidCallback);
    const background = new McpSdkClient(
      new InMemoryMcpCredentialStore(),
      {},
      {
        requestAuthorizationCallback: async () => {
          throw new Error("Must not prompt during a Run");
        },
      },
    );
    await expect(
      background.call(config, counter, {}, { cwd: process.cwd(), network }),
    ).rejects.toMatchObject({ code: "mcp_authorization_required" });
  });
});
