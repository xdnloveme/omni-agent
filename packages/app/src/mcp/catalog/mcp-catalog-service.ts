import { networkTargetFromUrl, throwIfAborted, type AgentToolDefinition } from "@omni-agent/core";
import type { Tool } from "@modelcontextprotocol/client";
import { ToolRegistry } from "../../registry/tool-registry";
import type { McpServerConfig } from "../config/types";
import {
  mcpToolName,
  validateMcpCatalog,
  MCP_CATALOG_LIMITS,
  type ValidatedMcpCatalog,
} from "./catalog";
import { McpSdkClient } from "../client/sdk-client";

interface ActiveServer {
  readonly catalog: ValidatedMcpCatalog;
  readonly originId: string;
}

export class McpCatalogService {
  readonly #active = new Map<string, ActiveServer>();
  constructor(
    private readonly registry: ToolRegistry,
    private readonly client: McpSdkClient,
  ) {}

  async refresh(
    config: McpServerConfig,
    signal?: AbortSignal,
    network?: import("@omni-agent/core").AuthorizedNetworkClient,
  ): Promise<void> {
    try {
      await this.refreshCatalog(config, signal, network);
    } catch (error) {
      if (!this.#active.has(config.id)) await this.client.close(config.id);
      throw error;
    }
  }

  private async refreshCatalog(
    config: McpServerConfig,
    signal?: AbortSignal,
    network?: import("@omni-agent/core").AuthorizedNetworkClient,
  ): Promise<void> {
    const originId = `mcp.${config.id.toLowerCase()}`;
    const snapshot = await this.client.discover(config, signal, network);
    const catalog = validateMcpCatalog(config.id, snapshot.tools, snapshot.instructions);
    const totalPromptTokens =
      catalog.promptTokens +
      [...this.#active.entries()]
        .filter(([id]) => id !== config.id)
        .reduce((total, [, entry]) => total + entry.catalog.promptTokens, 0);
    if (totalPromptTokens > MCP_CATALOG_LIMITS.promptTokens)
      throw Object.assign(new Error("MCP aggregate catalog prompt budget exceeded"), {
        code: "mcp_catalog_prompt_budget_exceeded",
      });
    // Discovery may settle after its Tool deadline. A cancelled activation must never commit.
    throwIfAborted(signal);
    this.registry.replaceOrigin(
      originId,
      catalog.tools.map((tool) => this.createTool(config, tool)),
    );
    this.#active.set(config.id, { catalog, originId });
  }

  async deactivate(serverId: string): Promise<void> {
    const active = this.#active.get(serverId);
    if (active) {
      this.registry.replaceOrigin(active.originId, []);
      this.#active.delete(serverId);
    }
    await this.client.close(serverId);
  }

  tools(serverId?: string): import("@omni-agent/core").RegisteredAgentTool[] {
    const origins = new Set(
      [...this.#active.entries()]
        .filter(([id]) => serverId === undefined || id === serverId)
        .map(([, entry]) => entry.originId),
    );
    return this.registry.list().filter((tool) => origins.has(tool.originId));
  }

  instructions(): readonly { serverId: string; content: string }[] {
    return [...this.#active.entries()].flatMap(([serverId, entry]) =>
      entry.catalog.instructions ? [{ serverId, content: entry.catalog.instructions }] : [],
    );
  }

  private createTool(config: McpServerConfig, tool: Tool): AgentToolDefinition {
    return {
      name: mcpToolName(config.id, tool.name),
      description: tool.description ?? `MCP tool ${tool.name} from ${config.id}`,
      schema: tool.inputSchema as Record<string, unknown>,
      inputConstraint: "prefer",
      timeout: { kind: "fixed", timeoutMs: 120_000 },
      execution: { kind: "in_process" },
      access:
        config.transport === "streamable_http"
          ? {
              kind: "dynamic",
              assess: () => ({
                resources: [config.url, ...(config.oauthTargets ?? [])].map((url) => ({
                  kind: "network" as const,
                  target: networkTargetFromUrl(url),
                  purpose: `Invoke MCP tool ${config.id}/${tool.name}`,
                })),
              }),
            }
          : { kind: "internal" },
      execute: (input, context) => this.client.call(config, tool, input, context),
    };
  }
}
