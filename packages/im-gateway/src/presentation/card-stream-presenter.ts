import type { PlatformMessageTarget } from "../contracts";
import type { PlatformAdapterPort } from "../platform/platform-port";

const CARD_SEGMENT_LENGTH = 28_000;

export class CardStreamPresenter {
  readonly #messageIds: string[];

  constructor(
    firstMessageId: string,
    private readonly target: PlatformMessageTarget,
    private readonly platform: PlatformAdapterPort,
  ) {
    this.#messageIds = [firstMessageId];
  }

  async update(text: string): Promise<void> {
    const segments = splitText(text || "处理中…");
    for (let index = 0; index < segments.length; index += 1) {
      const existingMessageId = this.#messageIds[index];
      if (existingMessageId) {
        await this.platform.updateCard(existingMessageId, segments[index]!);
      } else {
        const created = await this.platform.sendCard(this.target, segments[index]!);
        this.#messageIds.push(created.messageId);
      }
    }
    for (let index = segments.length; index < this.#messageIds.length; index += 1) {
      await this.platform.updateCard(
        this.#messageIds[index]!,
        "该续篇内容已被最终结果替换，请以上一张卡片为准。",
      );
    }
  }
}

function splitText(text: string): readonly string[] {
  const segments: string[] = [];
  for (let offset = 0; offset < text.length; offset += CARD_SEGMENT_LENGTH) {
    segments.push(text.slice(offset, offset + CARD_SEGMENT_LENGTH));
  }
  return segments.length > 0 ? segments : [""];
}
