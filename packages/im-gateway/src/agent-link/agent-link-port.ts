import type { AgentLinkEvent } from "./agent-link-events";

export interface AgentDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly packageName: string;
  readonly packageVersion: string;
}

export interface AgentConversationHandle {
  readonly agentId: string;
  readonly sessionId: string;
}

export interface AgentLinkPort {
  listAgents(): Promise<readonly AgentDescriptor[]>;
  createConversation(agentId: string): Promise<AgentConversationHandle>;
  openConversation(agentId: string, sessionId: string): Promise<AgentConversationHandle>;
  run(
    handle: AgentConversationHandle,
    requestId: string,
    text: string,
    signal?: AbortSignal,
  ): AsyncIterable<AgentLinkEvent>;
  cancel(requestId: string): Promise<void>;
  closeConversation(handle: AgentConversationHandle): Promise<void>;
  dispose(): Promise<void>;
}
