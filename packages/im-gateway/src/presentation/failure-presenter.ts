import type { AgentLinkEvent } from "../agent-link/agent-link-events";

export function presentFailure(event: Extract<AgentLinkEvent, { type: "failed" }>): string {
  if (event.code === "interaction_unavailable") {
    return "该操作需要交互确认，当前 IM 形态不支持，请到终端执行。";
  }
  return `任务失败：${event.message}`;
}
