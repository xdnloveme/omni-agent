import type { FilesystemCapabilityScope } from "./types";
import type { NetworkTarget } from "../network";

export interface AccessConsentRequest {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly targets: readonly NetworkTarget[];
  readonly scopes: readonly FilesystemCapabilityScope[];
  readonly purpose: string;
}

export type AccessConsentDecision = "approve" | "deny";
export type AccessConsentResponse =
  | AccessConsentDecision
  | {
      readonly decision: AccessConsentDecision;
      readonly permissionId: string;
      readonly reason: "user" | "expired" | "cancelled" | "disconnected" | "unavailable";
    };

export interface AccessConsentBroker {
  request(request: AccessConsentRequest, signal?: AbortSignal): Promise<AccessConsentResponse>;
}

export class DenyAccessConsentBroker implements AccessConsentBroker {
  async request(): Promise<AccessConsentResponse> {
    return "deny";
  }
}
