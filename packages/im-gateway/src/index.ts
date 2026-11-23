export { ImGateway, type ImGatewayOptions, type ImGatewayStartResult } from "./gateway";
export { loadGatewayConfig } from "./config/config-loader";
export type {
  AttachedBotHostConfig,
  BotHostConfig,
  GatewayBotConfig,
  GatewayConfig,
  ManagedBotHostConfig,
} from "./config/gateway-config";
export type {
  ConversationKey,
  ConversationRecord,
  InboundMessage,
  TaskRecord,
  TaskState,
} from "./contracts";
export type { AgentConversationHandle, AgentLinkPort } from "./agent-link/agent-link-port";
export type { AgentLinkEvent } from "./agent-link/agent-link-events";
export { HostProcessLink } from "./agent-link/host-process-link";
export {
  HostProcessSupervisor,
  type HostProcessSupervisorOptions,
} from "./agent-link/host-process-supervisor";
export { GatewayStateStore } from "./persistence/gateway-state-store";
