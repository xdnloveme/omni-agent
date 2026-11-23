import type { ConversationKey, ConversationRecord } from "../contracts";
import type { AgentConversationHandle, AgentLinkPort } from "../agent-link/agent-link-port";
import type { GatewayStateStore } from "../persistence/gateway-state-store";
import { conversationStorageKey } from "./conversation-key";

export class ConversationRouter {
  readonly #opening = new Map<string, Promise<AgentConversationHandle>>();

  constructor(
    private readonly agentId: string,
    private readonly link: AgentLinkPort,
    private readonly store: GatewayStateStore,
  ) {}

  resolve(key: ConversationKey): Promise<AgentConversationHandle> {
    const storageKey = conversationStorageKey(key);
    const existing = this.#opening.get(storageKey);
    if (existing) return existing;
    const operation = this.#open(storageKey).finally(() => this.#opening.delete(storageKey));
    this.#opening.set(storageKey, operation);
    return operation;
  }

  async #open(storageKey: string): Promise<AgentConversationHandle> {
    const persisted = await this.store.getConversation(storageKey);
    let handle: AgentConversationHandle;
    if (persisted) {
      if (persisted.agentId !== this.agentId) {
        throw new Error(
          `Conversation Agent binding mismatch: stored ${persisted.agentId}, configured ${this.agentId}. Restore the original binding or configure a new bot id; the existing Session is unchanged.`,
        );
      }
      handle = await this.link.openConversation(persisted.agentId, persisted.sessionId);
    } else {
      handle = await this.link.createConversation(this.agentId);
    }
    const record: ConversationRecord = {
      key: storageKey,
      agentId: handle.agentId,
      sessionId: handle.sessionId,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveConversation(record);
    return handle;
  }
}
