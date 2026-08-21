import { sanitizeSensitiveText, type ToolInvocationPreview } from "@omni-agent/core";

const ACTION_LABELS: Record<ToolInvocationPreview["action"], string> = {
  invoke: "running",
  execute: "running",
  read: "reading",
  edit: "editing",
  write: "writing",
  search: "searching",
  fetch: "fetching",
};

export function previewResource(preview: ToolInvocationPreview): string | undefined {
  const value = preview.resource?.value;
  return value ? sanitizeSensitiveText(singleLine(value), 4_096) : undefined;
}

export function describeToolPreview(preview: ToolInvocationPreview, toolName: string): string {
  const action = ACTION_LABELS[preview.action];
  const resource = previewResource(preview);
  return resource ? `${action} ${resource}` : `${action} ${toolName}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
