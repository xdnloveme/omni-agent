import type { ExtensionEvent } from "./extension-events";
import type { ToolResult } from "./types";

const TOOL_LIFECYCLE_NAMESPACE = "tool_lifecycle";
const ADAPTER_ERROR_EVENT = "adapter_error";

export type ToolLifecycleEvent = ExtensionEvent;

export interface ToolLifecycleStartInput {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface ToolLifecycleEndInput extends ToolLifecycleStartInput {
  result: ToolResult;
  durationMs: number;
}

export interface ToolLifecycleAdapter {
  supports(toolName: string): boolean;
  onStart(input: ToolLifecycleStartInput): ToolLifecycleEvent[];
  onEnd(input: ToolLifecycleEndInput): ToolLifecycleEvent[];
}

export function collectLifecycleStartEvents(
  adapters: readonly ToolLifecycleAdapter[] | undefined,
  input: ToolLifecycleStartInput,
): ToolLifecycleEvent[] {
  return collectLifecycleEvents(adapters, input, "start");
}

export function collectLifecycleEndEvents(
  adapters: readonly ToolLifecycleAdapter[] | undefined,
  input: ToolLifecycleEndInput,
): ToolLifecycleEvent[] {
  return collectLifecycleEvents(adapters, input, "end");
}

function collectLifecycleEvents(
  adapters: readonly ToolLifecycleAdapter[] | undefined,
  input: ToolLifecycleStartInput | ToolLifecycleEndInput,
  phase: "start" | "end",
): ToolLifecycleEvent[] {
  const events: ToolLifecycleEvent[] = [];
  for (const adapter of adapters ?? []) {
    try {
      if (!adapter.supports(input.toolName)) continue;
      events.push(
        ...(phase === "start"
          ? adapter.onStart(input)
          : adapter.onEnd(input as ToolLifecycleEndInput)),
      );
    } catch (err) {
      events.push(createAdapterErrorEvent(input, phase, err));
    }
  }
  return events;
}

function createAdapterErrorEvent(
  input: ToolLifecycleStartInput | ToolLifecycleEndInput,
  phase: "start" | "end",
  err: unknown,
): ToolLifecycleEvent {
  return {
    type: "extension_event",
    namespace: TOOL_LIFECYCLE_NAMESPACE,
    event: ADAPTER_ERROR_EVENT,
    toolCallId: input.toolCallId,
    payload: {
      toolName: input.toolName,
      phase,
      error: err instanceof Error ? err.message : String(err),
    },
  };
}
