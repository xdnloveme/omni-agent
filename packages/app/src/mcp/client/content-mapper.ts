import type { CallToolResult } from "@modelcontextprotocol/client";
import { isJsonValue, type JsonValue, type ToolResult } from "@omni-agent/core";
const MAX_MCP_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_MCP_META_BYTES = 64 * 1024;

export function mapMcpToolResult(result: CallToolResult, serverId: string): ToolResult {
  const rawBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (rawBytes > MAX_MCP_RESULT_BYTES) return unsupported("mcp_result_limit_exceeded", serverId);
  if (result._meta !== undefined) {
    if (!isJsonValue(result._meta)) return unsupported("mcp_meta_invalid", serverId);
    if (Buffer.byteLength(JSON.stringify(result._meta), "utf8") > MAX_MCP_META_BYTES) {
      return unsupported("mcp_meta_limit_exceeded", serverId);
    }
  }
  const content: ToolResult["content"] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text")
      content.push({
        type: "text",
        text: block.text,
        ...(block.annotations ? { annotations: block.annotations } : {}),
      });
    else if (block.type === "image")
      content.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
        ...(block.annotations ? { annotations: block.annotations } : {}),
      });
    else if (block.type === "audio")
      content.push({
        type: "audio",
        data: block.data,
        mimeType: block.mimeType,
        ...(block.annotations ? { annotations: block.annotations } : {}),
      });
    else if (block.type === "resource_link")
      content.push({
        type: "resource_link",
        name: block.name,
        uri: block.uri,
        ...(block.title ? { title: block.title } : {}),
        ...(block.description ? { description: block.description } : {}),
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
        ...(block.size === undefined ? {} : { size: block.size }),
        ...(block.annotations ? { annotations: block.annotations } : {}),
      });
    else if (block.type === "resource")
      content.push({
        type: "resource",
        resource: block.resource,
        ...(block.annotations ? { annotations: block.annotations } : {}),
      });
    else return unsupported("mcp_content_type_unsupported", serverId);
  }
  return {
    content,
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent as JsonValue }),
    isError: result.isError === true,
    meta: {
      mcpServerId: serverId,
      mcpResultBytes: rawBytes,
      ...(result._meta === undefined ? {} : { mcpMeta: result._meta }),
    },
  };
}
function unsupported(code: string, subject: string): ToolResult {
  return {
    content: [{ type: "text", text: `${code}: ${subject}` }],
    isError: true,
    meta: { code, retryable: false },
  };
}
