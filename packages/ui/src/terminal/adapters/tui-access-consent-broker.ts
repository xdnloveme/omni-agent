import type {
  AccessConsentBroker,
  AccessConsentRequest,
  AccessConsentResponse,
  InteractionSurfacePort,
} from "@omni-agent/core";
import { createAbortError, sanitizeSensitiveText, throwIfAborted } from "@omni-agent/core";

export class TuiAccessConsentBroker implements AccessConsentBroker {
  private readonly queue: PendingConsent[] = [];
  private active = false;

  constructor(private readonly surface: InteractionSurfacePort) {}

  request(request: AccessConsentRequest, signal?: AbortSignal): Promise<AccessConsentResponse> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const pending: PendingConsent = { request, signal, resolve, reject };
      if (signal) {
        pending.onAbort = () => {
          const index = this.queue.indexOf(pending);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(createAbortError(signal));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = true;
    void this.present(pending.request, pending.signal)
      .then(pending.resolve, pending.reject)
      .finally(() => {
        if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
        this.active = false;
        this.drain();
      });
  }

  private async present(
    request: AccessConsentRequest,
    signal?: AbortSignal,
  ): Promise<AccessConsentResponse> {
    const fieldId = "access";
    const response = await this.surface.request(
      {
        requestId: crypto.randomUUID(),
        title: "Approve and save access for this workspace and Agent?",
        tone: "warning",
        detail: consentDetail(request),
        message:
          "All listed access will be saved together and reused in controlled mode until revoked.",
        status: `awaiting access: ${request.toolName}`,
        completionStatus: `running: ${request.toolName}...`,
        fields: [
          {
            type: "single",
            id: fieldId,
            label: "Requested access",
            options: [
              {
                id: "approve",
                label: "Approve and save",
                description: "Save all listed paths and destinations for this workspace and Agent",
                tone: "positive",
              },
              {
                id: "deny",
                label: "Deny this request",
                description: "Do not run this operation; keep existing permissions unchanged",
                tone: "negative",
              },
            ],
          },
        ],
        completion: { type: "on_select", fieldId },
      },
      signal,
    );
    if (response.kind === "dismissed") return "deny";
    const value = response.values[fieldId];
    return value?.type === "single" && value.optionId === "approve" ? "approve" : "deny";
  }
}

interface PendingConsent {
  readonly request: AccessConsentRequest;
  readonly signal?: AbortSignal;
  readonly resolve: (response: AccessConsentResponse) => void;
  readonly reject: (error: unknown) => void;
  onAbort?: () => void;
}

function consentDetail(request: AccessConsentRequest): string {
  const heading = `Workspace: ${safeText(request.workspaceId)}\nAgent: ${safeText(request.agentId)}\nTool: ${safeText(request.toolName)}`;
  const targets = request.targets.map(
    (target) => `${target.scheme}://${safeText(target.host)}:${target.port}`,
  );
  const scopes = request.scopes.map((scope) => {
    const path = safeText(scope.path, 4_096);
    const target = scope.scope === "subtree" ? `${path} and all descendants` : path;
    return `${scope.access === "read_write" ? "Read/write" : "Read"}: ${target}`;
  });
  return `${heading}\nPurpose: ${safeText(request.purpose)}\n\n${[...scopes, ...targets].join("\n")}`;
}

function safeText(value: string, maxLength = 256): string {
  return sanitizeSensitiveText(value, maxLength)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}
