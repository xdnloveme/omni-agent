import type { AgentFailure, TokenUsage } from "../types";

export type PostEventHookEvent =
  | { readonly type: "run.completed"; readonly usage?: TokenUsage }
  | { readonly type: "run.failed"; readonly failure: AgentFailure }
  | {
      readonly type: "tool.completed";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly isError: boolean;
      readonly durationMs: number;
    }
  | {
      readonly type: "permission.resolved";
      readonly permissionId: string;
      readonly decision: "approve" | "deny";
      readonly reason: string;
    };

export interface TypedPostEventHook {
  readonly id: string;
  readonly events: readonly PostEventHookEvent["type"][];
  handle(event: PostEventHookEvent): void | Promise<void>;
}

export interface CommandPostEventHook {
  readonly id: string;
  readonly events: readonly PostEventHookEvent["type"][];
  readonly toolName: string;
  input(event: PostEventHookEvent): Readonly<Record<string, unknown>>;
}

export type PostEventHook = TypedPostEventHook | CommandPostEventHook;
export interface HookDiagnostic {
  readonly code: "hook_execution_failed";
  readonly hookId: string;
  readonly message: string;
}
