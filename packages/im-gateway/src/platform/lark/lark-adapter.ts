import { createAbortError, OperationDeadlineSupervisor, throwIfAborted } from "@omni-agent/core";
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
  readonly #startup = new OperationDeadlineSupervisor();
  #resolveReady?: () => void;
  #rejectReady?: (error: Error) => void;
  #handler?: (message: InboundMessage) => Promise<void>;
  #connection?: Promise<void>;

  constructor(private readonly options: LarkAdapterOptions) {
    this.#messages = new LarkMessageClient(options.appId, options.appSecret);
    this.#websocket = new WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      autoReconnect: true,
      handshakeTimeoutMs: 10_000,
      wsConfig: { pingTimeout: 10 },
      loggerLevel: LoggerLevel.warn,
      onReady: () => this.#resolveReady?.(),
      onError: (error) => this.#rejectReady?.(error),
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

  async start(
    handler: (message: InboundMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#handler = handler;
    try {
      await this.#startup.run({
        operationName: "Lark connection startup",
        externalSignal: signal,
        timeoutMs: 30_000,
        createTimeoutError: () => new Error("Lark connection did not become ready"),
        execute: async (startupSignal) => {
          const onAbort = () => {
            this.#websocket.close({ force: true });
            this.#rejectReady?.(createAbortError(startupSignal));
          };
          startupSignal.addEventListener("abort", onAbort, { once: true });
          try {
            this.#connection = Promise.resolve().then(() => {
              throwIfAborted(startupSignal);
              return this.#websocket.start({ eventDispatcher: this.#dispatcher });
            });
            await Promise.all([this.#connection, ready]);
            throwIfAborted(startupSignal);
          } finally {
            startupSignal.removeEventListener("abort", onAbort);
          }
        },
      });
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.#resolveReady = undefined;
      this.#rejectReady = undefined;
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
    this.#rejectReady?.(createAbortError());
    this.#websocket.close({ force: true });
    await this.#connection?.catch(() => undefined);
    this.#connection = undefined;
  }
}
