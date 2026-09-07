import { resolve } from "node:path";
import {
  escapeMarkupText,
  networkTargetFromUrl,
  sanitizeSensitiveText,
  type RegisteredAgentTool,
  type ToolCallCoordinator,
  type ToolCallEnvironment,
} from "@omni-agent/core";
import type {
  McpServerConfig,
  ResolvedMcpConfiguration,
  McpConfigDiagnostic,
} from "./config/types";
import type { McpCatalogService } from "./catalog/mcp-catalog-service";
import type { McpActivationStore } from "./activation-store";

interface McpConnectionState {
  readonly id: string;
  readonly enabled: boolean;
  readonly status: "disabled" | "connecting" | "ready" | "failed";
  readonly toolCount: number;
  readonly error?: string;
}

export type McpServerState =
  | McpConnectionState
  | {
      readonly status: "invalid";
      readonly id?: string;
      readonly enabled: false;
      readonly toolCount: 0;
      readonly error: string;
      readonly configurationError: McpConfigDiagnostic;
    };

/** Agent-local lifecycle owner. AgentApplication serializes transitions against Runs. */
export class AgentMcpController {
  private readonly states = new Map<string, McpConnectionState>();
  constructor(
    private readonly configuration: ResolvedMcpConfiguration,
    private readonly store: McpActivationStore,
    private readonly catalog: McpCatalogService,
    private readonly coordinator: ToolCallCoordinator,
    private readonly environment: ToolCallEnvironment,
  ) {
    for (const config of configuration.servers)
      this.states.set(config.id, {
        id: config.id,
        enabled: false,
        status: "disabled",
        toolCount: 0,
      });
  }
  list(): readonly McpServerState[] {
    return [
      ...[...this.states.values()].map((state) => ({ ...state })),
      ...this.configuration.diagnostics.map((diagnostic): McpServerState => ({
        id: diagnostic.serverId,
        enabled: false,
        status: "invalid",
        toolCount: 0,
        error: diagnostic.message,
        configurationError: { ...diagnostic },
      })),
    ];
  }
  async initialize(): Promise<void> {
    for (const id of await this.store.read()) if (this.states.has(id)) await this.connect(id);
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.requireConfig(id);
    await this.store.set(id, enabled);
    if (enabled) await this.connect(id);
    else {
      try {
        await this.catalog.deactivate(id);
      } finally {
        this.states.set(id, { id, enabled: false, status: "disabled", toolCount: 0 });
      }
    }
  }
  async retry(id: string): Promise<void> {
    if (!this.states.get(id)?.enabled) throw new Error("MCP server is disabled");
    await this.connect(id);
  }
  tools(): RegisteredAgentTool[] {
    return this.catalog.tools();
  }
  prompt(): string {
    return this.catalog
      .instructions()
      .map(
        ({ serverId, content }) =>
          `<mcp_instructions server="${escapeMarkupText(serverId)}">\n${escapeMarkupText(content)}\n</mcp_instructions>`,
      )
      .join("\n\n");
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.states.keys()].map((id) => this.catalog.deactivate(id)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Failed to close MCP integrations");
  }
  private requireConfig(id: string): McpServerConfig {
    const config = this.configuration.servers.find((entry) => entry.id === id);
    if (!config) {
      const diagnostic = this.configuration.diagnostics.find((entry) => entry.serverId === id);
      throw new Error(
        diagnostic
          ? `Invalid MCP server ${id}: ${diagnostic.message}`
          : `Unknown MCP server: ${id}`,
      );
    }
    return config.transport === "stdio"
      ? { ...config, cwd: resolve(this.environment.cwd, config.cwd ?? ".") }
      : config;
  }
  private async connect(id: string): Promise<void> {
    const config = this.requireConfig(id);
    this.states.set(id, {
      id,
      enabled: true,
      status: "connecting",
      toolCount: this.catalog.tools(id).length,
    });
    const tool: RegisteredAgentTool = {
      name: "mcp_activate",
      originId: "mcp-management",
      toolIdentity: "mcp-management:mcp_activate",
      description: "Activate an explicitly enabled MCP integration",
      schema: { type: "object", additionalProperties: false },
      timeout: { kind: "fixed", timeoutMs: 120_000 },
      execution: { kind: "in_process" },
      access:
        config.transport === "stdio"
          ? { kind: "internal" }
          : {
              kind: "dynamic",
              assess: () => ({
                resources: [config.url, ...(config.oauthTargets ?? [])].map((url) => ({
                  kind: "network" as const,
                  target: networkTargetFromUrl(url),
                  purpose: `Activate MCP ${id}`,
                })),
              }),
            },
      execute: async (_input, context) => {
        await this.catalog.refresh(config, context.signal, context.network);
        return { content: [{ type: "text", text: "MCP integration activated" }], isError: false };
      },
    };
    try {
      const batch = await this.coordinator.prepareBatch({
        tools: [tool],
        calls: [{ toolName: tool.name, toolCallId: `mcp:${id}:${crypto.randomUUID()}`, input: {} }],
        environment: this.environment,
      });
      for await (const event of this.coordinator.authorizeAndRun(batch.calls[0]!, {
        environment: this.environment,
      })) {
        if (event.type === "tool_end" && event.result.isError)
          throw new Error(
            event.result.content.find((block) => block.type === "text")?.text ??
              "MCP activation failed",
          );
      }
      this.states.set(id, {
        id,
        enabled: true,
        status: "ready",
        toolCount: this.catalog.tools(id).length,
      });
    } catch (error) {
      this.states.set(id, {
        id,
        enabled: true,
        status: "failed",
        toolCount: this.catalog.tools(id).length,
        error: sanitizeSensitiveText(error instanceof Error ? error.message : String(error)),
      });
    }
  }
}
