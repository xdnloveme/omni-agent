import { describe, expect, it } from "vitest";
import { conversationStorageKey, serializeConversationKey } from "./conversation-key";

describe("conversation key", () => {
  it("is stable and separates bot and scope", () => {
    const key = {
      platform: "lark" as const,
      botId: "coding",
      scope: "direct" as const,
      chatId: "oc_1",
    };

    expect(serializeConversationKey(key)).toBe("lark:coding:direct:oc_1");
    expect(conversationStorageKey(key)).toBe(conversationStorageKey({ ...key }));
    expect(conversationStorageKey(key)).not.toBe(
      conversationStorageKey({ ...key, scope: "group" }),
    );
    expect(conversationStorageKey(key)).not.toBe(
      conversationStorageKey({ ...key, botId: "other" }),
    );
  });
});
