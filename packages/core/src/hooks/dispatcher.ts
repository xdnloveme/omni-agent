import { cloneData, freezeData } from "../dataCopy";
import { sanitizeSensitiveText } from "../security";
import { reportRuntimeObservationDiagnostic } from "../runtime-observation/diagnostics";
import { evaluateToolBatchPolicies } from "../tool-calls/preparation-policies";
import type { ToolCallCoordinator } from "../tool-calls";
import type { AgentConfig } from "../types";
import type { HookDiagnostic, PostEventHook, PostEventHookEvent } from "./types";

export interface PostEventHookDispatchContext {
  readonly config: AgentConfig;
  readonly coordinator: ToolCallCoordinator;
  readonly environment: import("../tool-calls").ToolCallEnvironment;
  readonly signal?: AbortSignal;
  readonly diagnostic?: (value: HookDiagnostic) => void;
}

export async function dispatchPostEventHooks(
  event: PostEventHookEvent,
  context: PostEventHookDispatchContext,
): Promise<void> {
  for (const hook of context.config.hooks ?? []) {
    if (!hook.events.includes(event.type)) continue;
    try {
      if ("handle" in hook) await hook.handle(freezeData(cloneData(event)));
      else await runCommandHook(hook, event, context);
    } catch (error) {
      const sink = context.diagnostic ?? context.config.onHookDiagnostic;
      reportRuntimeObservationDiagnostic(
        sink
          ? () =>
              sink({
                code: "hook_execution_failed",
                hookId: hook.id,
                message: boundedMessage(error),
              })
          : undefined,
        `hook:${hook.id}`,
        error,
      );
    }
  }
}

async function runCommandHook(
  hook: Extract<PostEventHook, { toolName: string }>,
  event: PostEventHookEvent,
  context: PostEventHookDispatchContext,
): Promise<void> {
  // Hook-origin permissions must not recurse into the Agent's post-permission callback.
  const { onPermissionResolved: _onPermissionResolved, ...baseEnvironment } = context.environment;
  const environment = { ...baseEnvironment, origin: "hook" as const };
  const batch = await context.coordinator.prepareBatch({
    tools: context.config.tools,
    calls: [
      {
        toolName: hook.toolName,
        toolCallId: `hook:${hook.id}:${crypto.randomUUID()}`,
        input: { ...hook.input(freezeData(cloneData(event))) },
        signal: context.signal,
      },
    ],
    environment,
  });
  const policies = context.config.toolBatchPreparationPolicies ?? [];
  const decision = await evaluateToolBatchPolicies(policies, batch, { origin: "hook" });
  const call = batch.calls[0]!;
  const stream =
    decision.kind === "executable"
      ? context.coordinator.authorizeAndRun(call, {
          environment,
          revalidate: async () => {
            const current = await evaluateToolBatchPolicies(policies, batch, { origin: "hook" });
            if (current.kind !== "executable")
              return {
                content: [{ type: "text", text: current.message }],
                isError: true,
                meta: { code: current.code, executed: false },
              };
            return undefined;
          },
        })
      : context.coordinator.defer(
          call,
          { environment },
          {
            content: [{ type: "text", text: decision.message }],
            isError: true,
            meta: { code: decision.code, executed: false },
          },
        );
  for await (const result of stream)
    if (result.type === "tool_end" && result.result.isError)
      throw new Error(
        result.result.content.find((block) => block.type === "text")?.text ?? "Hook Tool failed",
      );
}

function boundedMessage(error: unknown): string {
  return sanitizeSensitiveText(error instanceof Error ? error.message : String(error), 8192);
}
