import {
  SKILL_TOOL_NAME,
  SkillEventName,
  SkillEventNamespace,
  SkillReadStatus,
  SkillSourceScope,
  type ExtensionEvent,
  type SkillSource,
} from "@omni-agent/core";
import type { OmniTui } from "../runtime/tui";
import { renderSkillReadEnd, renderSkillReadStart, type SkillRenderSink } from "./skill-renderer";

export class SkillStreamPresenter {
  constructor(private readonly tui: OmniTui) {}

  claimsTool(toolName: string): boolean {
    return toolName === SKILL_TOOL_NAME;
  }

  present(event: ExtensionEvent, sink: SkillRenderSink): boolean {
    if (event.namespace !== SkillEventNamespace.Skill) return false;
    if (event.event === SkillEventName.ReadStart) {
      const skillName = getString(event.payload, "skillName");
      sink.line();
      renderSkillReadStart(sink, skillName);
      this.tui.setStatus(`reading skill: ${skillName}...`);
      this.tui.setActivity("Reading skill…");
      return true;
    }
    if (event.event === SkillEventName.ReadEnd) {
      renderSkillReadEnd(sink, {
        skillName: getString(event.payload, "skillName"),
        status: getSkillReadStatus(event.payload),
        source: getSkillSource(event.payload.source),
        filePath: getOptionalString(event.payload, "filePath"),
        durationMs: getOptionalNumber(event.payload, "durationMs"),
        tokenEstimate: getOptionalNumber(event.payload, "tokenEstimate"),
        error: getOptionalString(event.payload, "error"),
      });
      this.tui.setStatus("thinking...");
      this.tui.setActivity("Thinking…");
      return true;
    }
    return false;
  }
}

function getString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}
function getOptionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}
function getOptionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}
function getSkillReadStatus(payload: Record<string, unknown>): "loaded" | "cached" | "failed" {
  const status = payload.status;
  if (status === SkillReadStatus.Cached || status === SkillReadStatus.Failed) return status;
  return SkillReadStatus.Loaded;
}
function getSkillSource(value: unknown): SkillSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const scope = (value as { scope?: unknown }).scope;
  return scope === SkillSourceScope.Project ||
    scope === SkillSourceScope.User ||
    scope === SkillSourceScope.Plugin
    ? (value as SkillSource)
    : undefined;
}
