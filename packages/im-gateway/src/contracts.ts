export type ConversationScope = "direct" | "group";

export interface ConversationKey {
  readonly platform: "lark";
  readonly botId: string;
  readonly scope: ConversationScope;
  readonly chatId: string;
}

export interface InboundMessage {
  readonly messageId: string;
  readonly eventId?: string;
  readonly senderId: string;
  readonly conversation: ConversationKey;
  readonly text: string;
}

export type TaskState =
  "accepted" | "queued" | "running" | "completed" | "failed" | "cancelled" | "rejected" | "unknown";

export interface ConversationRecord {
  readonly key: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly updatedAt: string;
}

export interface TaskRecord {
  readonly requestId: string;
  readonly platformMessageId: string;
  readonly botId: string;
  readonly conversationKey: string;
  readonly conversation: ConversationKey;
  readonly replyToMessageId: string;
  readonly state: TaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly responseMessageId?: string;
  readonly failureCode?: string;
  readonly recoveryNoticePending?: boolean;
}

export interface PresentedMessage {
  readonly messageId: string;
}

export interface PlatformMessageTarget {
  readonly conversation: ConversationKey;
  readonly replyToMessageId: string;
}
