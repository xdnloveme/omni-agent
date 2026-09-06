import type { InboundMessage, PlatformMessageTarget, PresentedMessage } from "../contracts";

export interface PlatformAdapterPort {
  start(handler: (message: InboundMessage) => Promise<void>): Promise<void>;
  sendText(target: PlatformMessageTarget, text: string): Promise<PresentedMessage>;
  sendCard(target: PlatformMessageTarget, text: string): Promise<PresentedMessage>;
  updateCard(messageId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}
