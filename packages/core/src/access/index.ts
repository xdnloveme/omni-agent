export { ToolAccessController } from "./tool-access-controller";
export type { ToolAccessControllerOptions } from "./tool-access-controller";
export { DenyAccessConsentBroker } from "./access-consent-port";
export type {
  AccessConsentBroker,
  AccessConsentDecision,
  AccessConsentRequest,
  AccessConsentResponse,
} from "./access-consent-port";
export {
  capabilityCoversResource,
  capabilityKey,
  candidateCanAuthorize,
  isConsentCandidateEligible,
  MAX_APPROVED_FILESYSTEM_ROOTS,
  normalizeFilesystemCapabilities,
  selectNarrowestCapability,
} from "./filesystem-capability";
export type {
  AccessResource,
  AccessSensitivity,
  FilesystemCapabilityScope,
  FilesystemConsentCandidate,
  ExecutionSettingsPort,
  ToolAccessContext,
  ToolAccessDescriptor,
  ToolAccessIntent,
  PreparedToolAccess,
  ToolAccessRequest,
  ToolAccessResult,
  ToolAccessGrant,
  WorkspaceExecutionSettings,
} from "./types";
