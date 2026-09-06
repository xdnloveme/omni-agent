import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import type { InboundMessage, PlatformMessageTarget } from "../../contracts";
import type { PlatformAdapterPort } from "../platform-port";
import { mapLarkEvent, type LarkReceiveEvent } from "./lark-event-mapper";
import { LarkMessageClient } from "./lark-message-client";

export interface LarkAdapterOptions {
  readonly botId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly verificationToken?: string;
  readonly encryptKey?: string;
}

export class LarkAdapter implements PlatformAdapterPort {
  readonly #messages: LarkMessageClient;
  readonly #websocket: WSClient;
  readonly #dispatcher: EventDispatcher;
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #handler?: (message: InboundMessage) => Promise<void>;
  #connection?: Promise<void>;

  constructor(private readonly options: LarkAdapterOptions) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#messages = new LarkMessageClient(options.appId, options.appSecret);
    this.#websocket = new WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      autoReconnect: true,
      handshakeTimeoutMs: 10_000,
      wsConfig: { pingTimeout: 10 },
      loggerLevel: LoggerLevel.warn,
      onReady: () => this.#resolveReady(),
      onError: (error) => this.#rejectReady(error),
    });
    this.#dispatcher = new EventDispatcher({
      verificationToken: options.verificationToken,
      encryptKey: options.encryptKey,
      loggerLevel: LoggerLevel.warn,
    }).register({
      "im.message.receive_v1": async (event) => {
        const mapping = mapLarkEvent(this.options.botId, event as LarkReceiveEvent);
        if (mapping.kind === "message") {
          await this.#handler?.(mapping.message);
        } else if (mapping.kind === "unsupported") {
          await this.#messages
            .sendText(
              {
                conversation: {
                  platform: "lark",
                  botId: this.options.botId,
                  scope: event.message.chat_type === "p2p" ? "direct" : "group",
                  chatId: event.message.chat_id,
                },
                replyToMessageId: event.message.message_id,
              },
              mapping.reason,
            )
            .catch(() => undefined);
        }
      },
    });
  }

  async start(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
    this.#connection = this.#websocket.start({ eventDispatcher: this.#dispatcher });
    try {
      await withTimeout(
        this.#connection.then(() => this.#ready),
        30_000,
        "Lark connection did not become ready",
      );
    } catch (error) {
      this.#handler = undefined;
      this.#websocket.close({ force: true });
      await this.#connection.catch(() => undefined);
      this.#connection = undefined;
      throw error;
    }
  }

  sendText(target: PlatformMessageTarget, text: string) {
    return this.#messages.sendText(target, text);
  }

  sendCard(target: PlatformMessageTarget, text: string) {
    return this.#messages.sendCard(target, text);
  }

  updateCard(messageId: string, text: string): Promise<void> {
    return this.#messages.updateCard(messageId, text);
  }

  async stop(): Promise<void> {
    this.#handler = undefined;
    this.#websocket.close({ force: true });
    await this.#connection?.catch(() => undefined);
    this.#connection = undefined;
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
