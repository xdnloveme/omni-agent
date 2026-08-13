import type { RegisteredAgentTool, ToolInvocationPreview } from "../types";

const MAX_PREVIEW_VALUE_LENGTH = 4_096;

export function projectToolInvocationPreview(
  tool: RegisteredAgentTool | undefined,
  input: Readonly<Record<string, unknown>>,
): ToolInvocationPreview {
  const presentation = tool?.invocation ?? { action: "invoke" as const };
  const descriptor = presentation.resource;
  if (!descriptor) return { action: presentation.action };
  const value = input[descriptor.inputKey];
  if (typeof value !== "string" || value.length === 0) return { action: presentation.action };
  return {
    action: presentation.action,
    resource: {
      kind: descriptor.kind,
      value: value.slice(0, MAX_PREVIEW_VALUE_LENGTH),
    },
  };
}
