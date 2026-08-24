import type { FilesystemCapabilityScope } from "./types";

export type AccessConsentRequest =
  | {
      readonly kind: "network";
      readonly workspaceId: string;
      readonly agentId: string;
      readonly toolName: string;
    }
  | {
      readonly kind: "filesystem";
      readonly workspaceId: string;
      readonly agentId: string;
      readonly toolName: string;
      readonly scopes: readonly FilesystemCapabilityScope[];
    };

export type AccessConsentResponse = "approve" | "deny";

export interface AccessConsentBroker {
  request(request: AccessConsentRequest, signal?: AbortSignal): Promise<AccessConsentResponse>;
}

export class DenyAccessConsentBroker implements AccessConsentBroker {
  async request(): Promise<AccessConsentResponse> {
    return "deny";
  }
}
