import { randomUUID } from "node:crypto";
import {
  networkTargetKey,
  type AccessConsentBroker,
  type AccessConsentDecision,
  type AccessConsentRequest,
  type AccessConsentResponse,
} from "@omni-agent/core";

const PERMISSION_TTL_MS = 60_000;
export type AgentServicePermissionEvent =
  | {
      readonly type: "requested";
      readonly requestId: string;
      readonly permissionId: string;
      readonly expiresAt: number;
      readonly presentation: PermissionPresentation;
    }
  | {
      readonly type: "resolved";
      readonly requestId: string;
      readonly permissionId: string;
      readonly decision: AccessConsentDecision;
      readonly reason: "user" | "expired" | "cancelled" | "disconnected";
    };
export interface PermissionPresentation {
  readonly title: string;
  readonly resources: readonly string[];
}
interface PendingPermission {
  readonly requestId: string;
  readonly resolve: (decision: AccessConsentResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class AgentServiceAccessConsentBroker implements AccessConsentBroker {
  readonly #pending = new Map<string, PendingPermission>();
  #sink: ((event: AgentServicePermissionEvent) => void | Promise<void>) | undefined;

  subscribe(sink: (event: AgentServicePermissionEvent) => void | Promise<void>): () => void {
    if (this.#sink) throw new Error("Agent Service permission sink is already bound");
    this.#sink = sink;
    return () => {
      if (this.#sink !== sink) return;
      this.#sink = undefined;
      for (const [id] of this.#pending) this.finish(id, "deny", "disconnected");
    };
  }

  async request(
    request: AccessConsentRequest,
    signal?: AbortSignal,
  ): Promise<AccessConsentResponse> {
    const sink = this.#sink;
    if (!sink || signal?.aborted)
      return { decision: "deny", permissionId: request.toolCallId, reason: "unavailable" };
    const display = presentation(request);
    const permissionId = randomUUID();
    const expiresAt = Date.now() + PERMISSION_TTL_MS;
    const result = new Promise<AccessConsentResponse>((resolve) => {
      const timer = setTimeout(
        () => this.finish(permissionId, "deny", "expired"),
        PERMISSION_TTL_MS,
      );
      timer.unref?.();
      this.#pending.set(permissionId, {
        requestId: request.toolCallId,
        resolve,
        timer,
        settled: false,
      });
    });
    const onAbort = () => this.finish(permissionId, "deny", "cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    // Transport delivery is observed, but must not gate cancellation or permission expiry.
    void Promise.resolve()
      .then(() => {
        if (!this.#pending.has(permissionId)) return;
        return sink({
          type: "requested",
          requestId: request.toolCallId,
          permissionId,
          expiresAt,
          presentation: display,
        });
      })
      .catch(() => this.finish(permissionId, "deny", "cancelled"));
    try {
      return await result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  resolve(permissionId: string, decision: AccessConsentDecision): boolean {
    if (!this.#pending.has(permissionId)) return false;
    this.finish(permissionId, decision, "user");
    return true;
  }

  private finish(
    permissionId: string,
    decision: AccessConsentDecision,
    reason: Extract<AgentServicePermissionEvent, { type: "resolved" }>["reason"],
  ): void {
    const pending = this.#pending.get(permissionId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.#pending.delete(permissionId);
    clearTimeout(pending.timer);
    pending.resolve({ decision, permissionId, reason });
    const sink = this.#sink;
    void Promise.resolve()
      .then(() =>
        sink?.({
          type: "resolved",
          requestId: pending.requestId,
          permissionId,
          decision,
          reason,
        }),
      )
      .catch(() => undefined);
  }
}

function presentation(request: AccessConsentRequest): PermissionPresentation {
  const resources = [
    ...request.scopes.map((scope) => `${scope.access}:${scope.scope}:${scope.path}`),
    ...request.targets.map(networkTargetKey),
  ];
  const title = `Workspace: ${request.workspaceId}\nAgent: ${request.agentId}\nTool: ${request.toolName}\nPurpose: ${request.purpose}`;
  // Never ask the user to approve resources that were omitted or truncated for transport.
  if (
    resources.length > 128 ||
    resources.some((value) => value.length > 512) ||
    title.length > 4096
  )
    throw new Error("Permission presentation exceeds the host display limits");
  return {
    title,
    resources,
  };
}
