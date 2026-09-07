import { estimateContextTextTokens } from "@omni-agent/core";
import type { Tool } from "@modelcontextprotocol/client";
import { normalizeMcpName } from "../config/types";

export const MCP_CATALOG_LIMITS = Object.freeze({
  toolsPerServer: 128,
  toolSchemaBytes: 64 * 1024,
  instructionsBytes: 64 * 1024,
  rawCatalogBytes: 2 * 1024 * 1024,
  promptTokens: 32_000,
});
export interface ValidatedMcpCatalog {
  readonly instructions?: string;
  readonly tools: readonly Tool[];
  readonly promptTokens: number;
  readonly rawBytes: number;
}

export function validateMcpCatalog(
  serverId: string,
  tools: readonly Tool[],
  instructions?: string,
): ValidatedMcpCatalog {
  if (tools.length > MCP_CATALOG_LIMITS.toolsPerServer)
    throw catalogError("mcp_tool_limit_exceeded", serverId);
  if (instructions && bytes(instructions) > MCP_CATALOG_LIMITS.instructionsBytes)
    throw catalogError("mcp_instructions_limit_exceeded", serverId);
  const names = new Set<string>();
  for (const tool of tools) {
    const name = normalizeMcpName(tool.name);
    if (names.has(name)) throw catalogError("mcp_tool_name_collision", `${serverId}:${tool.name}`);
    names.add(name);
    if (
      bytes(JSON.stringify(tool.inputSchema)) > MCP_CATALOG_LIMITS.toolSchemaBytes ||
      (tool.outputSchema !== undefined &&
        bytes(JSON.stringify(tool.outputSchema)) > MCP_CATALOG_LIMITS.toolSchemaBytes)
    )
      throw catalogError("mcp_tool_schema_limit_exceeded", `${serverId}:${tool.name}`);
  }
  const raw = JSON.stringify({ instructions, tools });
  const rawBytes = bytes(raw);
  if (rawBytes > MCP_CATALOG_LIMITS.rawCatalogBytes)
    throw catalogError("mcp_catalog_limit_exceeded", serverId);
  const promptTokens = estimateContextTextTokens(raw);
  if (promptTokens > MCP_CATALOG_LIMITS.promptTokens)
    throw catalogError("mcp_catalog_prompt_budget_exceeded", serverId);
  return Object.freeze({
    ...(instructions ? { instructions } : {}),
    tools: Object.freeze([...tools]),
    promptTokens,
    rawBytes,
  });
}
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${normalizeMcpName(serverId)}__${normalizeMcpName(toolName)}`;
}
function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function catalogError(code: string, subject: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${subject}`), { code });
}
