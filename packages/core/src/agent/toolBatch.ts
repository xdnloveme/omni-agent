import { randomUUID } from "node:crypto";
import type { ToolCallContent } from "../messages";
import { projectToolInvocationPreview } from "../tool-calls";
import type { RegisteredAgentTool, ToolBatchDescriptor } from "../types";

export function createToolBatchDescriptor(
  calls: readonly ToolCallContent[],
  tools: readonly RegisteredAgentTool[],
  modelCallId: string,
): ToolBatchDescriptor {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    batchId: randomUUID(),
    modelCallId,
    members: calls.map((call) => ({
      toolName: call.name,
      toolCallId: call.id,
      preview: projectToolInvocationPreview(toolsByName.get(call.name), call.arguments),
    })),
  };
}
