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
    const filesystem = request.kind === "filesystem";
    const response = await this.surface.request(
      {
        requestId: crypto.randomUUID(),
        title: consentTitle(request),
        tone: "warning",
        detail: consentDetail(request),
        message: filesystem
          ? "This access will remain available in controlled mode until it is revoked."
          : "Network access is currently disabled in controlled mode.",
        status: `awaiting ${filesystem ? "filesystem" : "network"} access: ${request.toolName}`,
        completionStatus: `running: ${request.toolName}...`,
        fields: [
          {
            type: "single",
            id: fieldId,
            label: filesystem ? "Filesystem access" : "Network access",
            options: [
              {
                id: "approve",
                label: filesystem ? "Approve access" : "Enable network",
                description: filesystem
                  ? "Add these paths to the controlled workspace boundary"
                  : "Enable normal network access for this workspace",
                tone: "positive",
              },
              {
                id: "deny",
                label: filesystem ? "Keep restricted" : "Keep disabled",
                description: filesystem
                  ? "Do not add these filesystem paths"
                  : "Do not run this network operation",
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

function consentTitle(request: AccessConsentRequest): string {
  if (request.kind === "network") return "Enable network for this workspace?";
  if (request.scopes.every((scope) => scope.scope === "exact")) {
    return "Approve file access for this workspace?";
  }
  if (request.scopes.every((scope) => scope.scope === "subtree")) {
    return "Approve folder access for this workspace?";
  }
  return "Approve filesystem access for this workspace?";
}

function consentDetail(request: AccessConsentRequest): string {
  const heading = `Agent: ${safeText(request.agentId)}\nTool: ${safeText(request.toolName)}`;
  if (request.kind === "network") return heading;
  const scopes = request.scopes.map((scope) => {
    const path = safeText(scope.path, 4_096);
    const target = scope.scope === "subtree" ? `${path} and all descendants` : path;
    return `${scope.access === "read_write" ? "Read/write" : "Read"}: ${target}`;
  });
  return `${heading}\n\n${scopes.join("\n")}`;
}

function safeText(value: string, maxLength = 256): string {
  return sanitizeSensitiveText(value, maxLength)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}
