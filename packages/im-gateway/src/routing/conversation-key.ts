import { createHash } from "node:crypto";
import type { ConversationKey } from "../contracts";

export function serializeConversationKey(key: ConversationKey): string {
  return `${key.platform}:${key.botId}:${key.scope}:${key.chatId}`;
}

export function conversationStorageKey(key: ConversationKey): string {
  return createHash("sha256").update(serializeConversationKey(key)).digest("base64url");
}
