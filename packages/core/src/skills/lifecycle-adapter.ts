import { SKILL_TOOL_NAME, SkillEventName, SkillEventNamespace, SkillReadStatus } from "./constants";
import type {
  ToolLifecycleAdapter,
  ToolLifecycleEndInput,
  ToolLifecycleEvent,
  ToolLifecycleStartInput,
} from "../tool-lifecycle";

export class SkillReadLifecycleAdapter implements ToolLifecycleAdapter {
  supports(toolName: string): boolean {
    return toolName === SKILL_TOOL_NAME;
  }

  onStart(input: ToolLifecycleStartInput): ToolLifecycleEvent[] {
    return [
      {
        type: "extension_event",
        namespace: SkillEventNamespace.Skill,
        event: SkillEventName.ReadStart,
        toolCallId: input.toolCallId,
        payload: {
          skillName: typeof input.input.name === "string" ? input.input.name : "",
        },
      },
    ];
  }

  onEnd(input: ToolLifecycleEndInput): ToolLifecycleEvent[] {
    const meta = input.result.meta;
    const skillName =
      typeof meta?.skillName === "string"
        ? meta.skillName
        : typeof input.input.name === "string"
          ? input.input.name
          : "";

    return [
      {
        type: "extension_event",
        namespace: SkillEventNamespace.Skill,
        event: SkillEventName.ReadEnd,
        toolCallId: input.toolCallId,
        payload: {
          skillName,
          status: normalizeSkillReadStatus(meta?.status, input.result.isError),
          source: meta?.source,
          filePath: typeof meta?.filePath === "string" ? meta.filePath : undefined,
          durationMs: input.durationMs,
          tokenEstimate: typeof meta?.tokenEstimate === "number" ? meta.tokenEstimate : undefined,
          error: typeof meta?.error === "string" ? meta.error : undefined,
        },
      },
    ];
  }
}

function normalizeSkillReadStatus(
  status: unknown,
  isError: boolean,
): "loaded" | "cached" | "failed" {
  if (isError) return SkillReadStatus.Failed;
  return status === SkillReadStatus.Cached ? SkillReadStatus.Cached : SkillReadStatus.Loaded;
}
