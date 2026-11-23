import { describe, expect, it } from "vitest";
import { mapLarkEvent, type LarkReceiveEvent } from "./lark-event-mapper";

describe("mapLarkEvent", () => {
  it("maps a direct text message", () => {
    const mapped = mapLarkEvent("coding", event());
    expect(mapped).toMatchObject({
      kind: "message",
      message: {
        messageId: "om_1",
        senderId: "ou_1",
        text: "hello",
        conversation: { botId: "coding", scope: "direct", chatId: "oc_1" },
      },
    });
  });

  it("ignores app senders and rejects groups", () => {
    expect(
      mapLarkEvent("coding", event({ sender: { ...event().sender, sender_type: "app" } })),
    ).toEqual({ kind: "ignored" });
    expect(
      mapLarkEvent("coding", event({ message: { ...event().message, chat_type: "group" } })),
    ).toEqual({ kind: "unsupported", reason: "第一期仅支持机器人单聊。" });
  });

  it("maps a direct post message to deterministic plain text", () => {
    const mapped = mapLarkEvent(
      "coding",
      event({
        message: {
          ...event().message,
          message_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "Request",
              content: [
                [
                  { tag: "text", text: "Please review " },
                  { tag: "a", text: "this change", href: "https://example.com" },
                ],
                [{ tag: "at", user_name: "Alice", user_id: "ou_alice" }],
              ],
            },
          }),
        },
      }),
    );

    expect(mapped).toMatchObject({
      kind: "message",
      message: { text: "Request\nPlease review this change\n@Alice" },
    });
  });
});

function event(overrides: Partial<LarkReceiveEvent> = {}): LarkReceiveEvent {
  return {
    sender: {
      sender_id: { open_id: "ou_1" },
      sender_type: "user",
      tenant_key: "tenant",
    },
    message: {
      message_id: "om_1",
      root_id: "",
      parent_id: "",
      create_time: "0",
      update_time: "0",
      chat_id: "oc_1",
      thread_id: "",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: " hello " }),
      mentions: [],
    },
    ...overrides,
  };
}
