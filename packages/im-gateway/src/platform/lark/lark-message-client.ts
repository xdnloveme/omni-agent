import { Client } from "@larksuiteoapi/node-sdk";
import type { PlatformMessageTarget, PresentedMessage } from "../../contracts";
import { renderLarkCard } from "./lark-card-renderer";

export class LarkMessageClient {
  readonly #client: Client;

  constructor(appId: string, appSecret: string) {
    this.#client = new Client({ appId, appSecret });
  }

  async sendText(target: PlatformMessageTarget, text: string): Promise<PresentedMessage> {
    const response = await this.#client.im.message.reply({
      path: { message_id: target.replyToMessageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return { messageId: requireMessageId(response.code, response.msg, response.data?.message_id) };
  }

  async sendCard(target: PlatformMessageTarget, text: string): Promise<PresentedMessage> {
    const response = await this.#client.im.message.reply({
      path: { message_id: target.replyToMessageId },
      data: {
        msg_type: "interactive",
        content: renderLarkCard(text),
      },
    });
    return { messageId: requireMessageId(response.code, response.msg, response.data?.message_id) };
  }

  async updateCard(messageId: string, text: string): Promise<void> {
    const response = await this.#client.im.message.patch({
      path: { message_id: messageId },
      data: { content: renderLarkCard(text) },
    });
    if (response.code && response.code !== 0) {
      throw new Error(`Lark card update failed (${response.code}): ${response.msg ?? "unknown"}`);
    }
  }
}

function requireMessageId(
  code: number | undefined,
  message: string | undefined,
  messageId: string | undefined,
): string {
  if (code && code !== 0) throw new Error(`Lark message failed (${code}): ${message ?? "unknown"}`);
  if (!messageId) throw new Error("Lark message response did not include message_id");
  return messageId;
}
