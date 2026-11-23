import type { RawMessageEvent } from "@larksuiteoapi/node-sdk";
import type { InboundMessage } from "../../contracts";

export interface LarkReceiveEvent extends RawMessageEvent {
  readonly event_id?: string;
}

export type LarkEventMapping =
  | { readonly kind: "message"; readonly message: InboundMessage }
  | { readonly kind: "ignored" }
  | { readonly kind: "unsupported"; readonly reason: string };

export function mapLarkEvent(botId: string, event: LarkReceiveEvent): LarkEventMapping {
  if (event.sender.sender_type === "app") return { kind: "ignored" };
  const senderId = event.sender.sender_id.open_id;
  if (!senderId) return { kind: "ignored" };
  if (event.message.chat_type !== "p2p") {
    return { kind: "unsupported", reason: "第一期仅支持机器人单聊。" };
  }
  if (!["text", "post"].includes(event.message.message_type)) {
    return { kind: "unsupported", reason: "第一期仅支持文本消息。" };
  }
  let text: string;
  try {
    const content: unknown = JSON.parse(event.message.content);
    text =
      event.message.message_type === "text" ? parseTextContent(content) : parsePostContent(content);
  } catch {
    return { kind: "unsupported", reason: "无法解析这条文本消息。" };
  }
  if (!text) return { kind: "ignored" };
  if (text.length > 32_768) {
    return { kind: "unsupported", reason: "消息超过 32768 字符，请拆分后重试。" };
  }
  return {
    kind: "message",
    message: {
      messageId: event.message.message_id,
      ...(event.event_id ? { eventId: event.event_id } : {}),
      senderId,
      conversation: {
        platform: "lark",
        botId,
        scope: "direct",
        chatId: event.message.chat_id,
      },
      text,
    },
  };
}

function parseTextContent(content: unknown): string {
  if (!isRecord(content) || typeof content.text !== "string") throw new Error();
  return content.text.trim();
}

function parsePostContent(content: unknown): string {
  if (!isRecord(content)) throw new Error();
  const document = isPostDocument(content) ? content : Object.values(content).find(isPostDocument);
  if (!document) throw new Error();
  const lines = document.content.map((line) =>
    line
      .map((element) => {
        if (!isRecord(element)) return "";
        if (["text", "a"].includes(String(element.tag)) && typeof element.text === "string") {
          return element.text;
        }
        if (element.tag === "at" && typeof element.user_name === "string") {
          return `@${element.user_name}`;
        }
        return "";
      })
      .join(""),
  );
  return [document.title, ...lines]
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim();
}

function isPostDocument(value: unknown): value is {
  readonly title: string;
  readonly content: readonly (readonly unknown[])[];
} {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    Array.isArray(value.content) &&
    value.content.every((line) => Array.isArray(line))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
