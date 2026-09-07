import { describe, expect, it, vi } from "vitest";

const keytar = vi.hoisted(() => ({
  getPassword: vi.fn(async (_service: string, _account: string) => null),
  setPassword: vi.fn(async (_service: string, _account: string, _value: string) => undefined),
  deletePassword: vi.fn(async (_service: string, _account: string) => true),
}));

vi.mock("keytar", () => ({ default: keytar }));
import { ToolRegistry } from "../registry/tool-registry";
import {
  InMemoryMcpCredentialStore,
  KeychainMcpCredentialStore,
  KeychainMcpOAuthProvider,
  McpSdkClient,
  mapMcpToolResult,
  mcpToolName,
  validateMcpCatalog,
  parseMcpConfiguration,
} from "../mcp";

describe("MCP client boundaries", () => {
  it("rejects SDK implicit stdio environment inheritance before spawning", async () => {
    const client = new McpSdkClient(new InMemoryMcpCredentialStore());
    await expect(
      client.discover({ id: "local", transport: "stdio", command: "must-not-spawn" }),
    ).rejects.toMatchObject({ code: "mcp_stdio_environment_not_authorized" });
  });

  it("requires an authorized network client for catalog discovery", async () => {
    const client = new McpSdkClient(new InMemoryMcpCredentialStore());
    await expect(
      client.discover({
        id: "remote",
        transport: "streamable_http",
        url: "https://example.com/mcp",
      }),
    ).rejects.toThrow("Authorized MCP network client is unavailable");
  });
  it("maps arbitrary issuer-scoped credential ids to bounded Keychain accounts", async () => {
    const store = new KeychainMcpCredentialStore();
    const logicalId = `oauth:docs:tokens:${"https://issuer.example/path/".repeat(8)}`;
    await store.set(logicalId, "secret");
    const account = keytar.setPassword.mock.calls[0]?.[1];
    expect(account).toMatch(/^credential:[a-f0-9]{64}$/);
    expect(account).not.toContain("issuer.example");
  });

  it("normalizes names and rejects catalog collisions and oversized schemas before registration", () => {
    expect(mcpToolName("Docs Server", "Find Page")).toBe("mcp__docs_server__find_page");
    expect(() => validateMcpCatalog("docs", [tool("Find Page"), tool("find_page")])).toThrowError(
      expect.objectContaining({ code: "mcp_tool_name_collision" }),
    );
    expect(() =>
      validateMcpCatalog("docs", [
        tool("large", { type: "object", description: "x".repeat(70_000) }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "mcp_tool_schema_limit_exceeded" }));
  });

  it("fails closed on server config collisions and credential-bearing URLs", () => {
    expect(
      parseMcpConfiguration(
        {
          servers: [
            { id: "docs", transport: "streamable_http", url: "https://secret@example.com/mcp" },
          ],
        },
        "project",
      ).diagnostics[0]?.message,
    ).toContain("contains credentials");
    expect(
      parseMcpConfiguration(
        {
          servers: [
            { id: "docs", transport: "stdio", command: "one" },
            { id: "DOCS", transport: "stdio", command: "two" },
          ],
        },
        "project",
      ).diagnostics[0]?.message,
    ).toContain("collision");
  });

  it("preserves Phase A and Phase B content without flattening it", () => {
    expect(
      mapMcpToolResult(
        {
          content: [
            { type: "text", text: "ok", annotations: { audience: ["user"] } },
            {
              type: "image",
              data: "AA==",
              mimeType: "image/png",
              annotations: { audience: ["user"] },
            },
          ],
          structuredContent: { answer: 42 },
        },
        "docs",
      ),
    ).toMatchObject({
      isError: false,
      structuredContent: { answer: 42 },
      content: [
        { type: "text", annotations: { audience: ["user"] } },
        { type: "image", annotations: { audience: ["user"] } },
      ],
    });
    expect(
      mapMcpToolResult(
        { content: [{ type: "audio", data: "AA==", mimeType: "audio/wav" }] },
        "docs",
      ),
    ).toMatchObject({ isError: false, content: [{ type: "audio", mimeType: "audio/wav" }] });
  });

  it("keeps bounded JSON MCP metadata out of model content and rejects oversized metadata", () => {
    expect(
      mapMcpToolResult(
        { content: [{ type: "text", text: "ok" }], _meta: { traceId: "trace-1" } },
        "docs",
      ),
    ).toMatchObject({
      content: [{ type: "text", text: "ok" }],
      meta: { mcpMeta: { traceId: "trace-1" } },
    });
    expect(
      mapMcpToolResult(
        { content: [{ type: "text", text: "ok" }], _meta: { value: "x".repeat(70_000) } },
        "docs",
      ),
    ).toMatchObject({ isError: true, meta: { code: "mcp_meta_limit_exceeded" } });
  });

  it("replaces one origin catalog only after complete validation", () => {
    const registry = new ToolRegistry();
    registry.replaceOrigin("mcp.docs", [agentTool("first")]);
    expect(() =>
      registry.replaceOrigin("mcp.docs", [agentTool("dup"), agentTool("dup")]),
    ).toThrow();
    expect(registry.list().map((entry) => entry.name)).toEqual(["first"]);
  });

  it("keeps credentials outside configuration through the credential port", async () => {
    const store = new InMemoryMcpCredentialStore();
    await store.set("docs", "secret");
    await expect(store.get("docs")).resolves.toBe("secret");
    await store.delete("docs");
    await expect(store.get("docs")).resolves.toBeUndefined();
  });

  it("persists OAuth redirect state, PKCE and tokens through the credential port", async () => {
    const store = new InMemoryMcpCredentialStore();
    const redirected: string[] = [];
    const createProvider = () =>
      new KeychainMcpOAuthProvider(
        {
          id: "docs",
          transport: "streamable_http",
          url: "https://mcp.example/mcp",
          oauthTargets: ["https://auth.example/authorize", "https://auth.example/token"],
          oauth: { credentialId: "docs", redirectUrl: "http://127.0.0.1:48100/callback" },
        },
        store,
        { redirectToAuthorization: (_serverId, url) => void redirected.push(url.toString()) },
      );
    const provider = createProvider();
    const state = await provider.state();
    await provider.saveCodeVerifier("verifier-secret");
    await provider.saveTokens(
      {
        access_token: "access-secret",
        token_type: "bearer",
        refresh_token: "refresh-secret",
      },
      { issuer: "https://auth.example" },
    );
    await provider.redirectToAuthorization(
      new URL(`https://auth.example/authorize?state=${state}`),
    );
    await expect(createProvider().codeVerifier()).resolves.toBe("verifier-secret");
    await expect(createProvider().tokens()).resolves.toMatchObject({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
    });
    await expect(provider.tokens({ issuer: "https://other.example" })).resolves.toBeUndefined();
    await provider.saveTokens(
      { access_token: "replacement-secret", token_type: "bearer" },
      { issuer: "https://other.example" },
    );
    await expect(provider.tokens({ issuer: "https://auth.example" })).resolves.toBeUndefined();
    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: "replacement-secret",
    });
    await expect(provider.sensitiveValues()).resolves.toEqual(
      expect.arrayContaining(["replacement-secret", "verifier-secret", state]),
    );
    await expect(provider.validateCallbackState(state)).resolves.toBeUndefined();
    await expect(provider.validateCallbackState(state)).rejects.toMatchObject({
      code: "mcp_oauth_state_mismatch",
    });
    expect(redirected).toHaveLength(1);
    for (const scope of ["client", "all"] as const) {
      const context = { issuer: "https://auth.example" };
      await provider.saveClientInformation({ client_id: "expired-client" }, context);
      const restored = createProvider();
      await expect(restored.clientInformation(context)).resolves.toMatchObject({
        client_id: "expired-client",
      });
      await restored.invalidateCredentials(scope);
      const renewed = createProvider();
      await expect(renewed.clientInformation(context)).resolves.toBeUndefined();
      await renewed.saveClientInformation({ client_id: "new-client" }, context);
      await expect(createProvider().clientInformation(context)).resolves.toMatchObject({
        client_id: "new-client",
      });
    }
    await createProvider().invalidateCredentials("all");
    await expect(createProvider().tokens()).resolves.toBeUndefined();
  });

  it("requires explicit OAuth target URLs and a secure or loopback callback", () => {
    expect(
      parseMcpConfiguration(
        {
          servers: [
            {
              id: "docs",
              transport: "streamable_http",
              url: "https://mcp.example/mcp",
              bearerCredentialId: "bearer",
              oauth: { credentialId: "oauth", redirectUrl: "https://app.example/callback" },
            },
          ],
        },
        "project",
      ).diagnostics[0]?.message,
    ).toContain("cannot configure bearer and OAuth");
    expect(
      parseMcpConfiguration(
        {
          servers: [
            {
              id: "docs",
              transport: "streamable_http",
              url: "https://mcp.example/mcp",
              oauth: { credentialId: "oauth", redirectUrl: "http://app.example/callback" },
            },
          ],
        },
        "project",
      ).diagnostics[0]?.message,
    ).toContain("must be HTTPS or loopback");
  });
});

function tool(
  name: string,
  inputSchema: { type: "object" } & Record<string, unknown> = { type: "object" },
) {
  return { name, inputSchema };
}
function agentTool(name: string) {
  return {
    name,
    description: name,
    schema: { type: "object" },
    access: { kind: "internal" as const },
    execution: { kind: "in_process" as const },
    timeout: { kind: "none" as const },
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    },
  };
}
