import { describe, expect, it } from "vitest";
import type { AgentLinkPort } from "../agent-link/agent-link-port";
import type { TaskRecord } from "../contracts";
import type { GatewayBotConfig } from "../config/gateway-config";
import type { PlatformAdapterPort } from "../platform/platform-port";
import { BotRuntime } from "./bot-runtime";

describe("BotRuntime recovery presentation", () => {
  it("sends a recovery notice when the original response card was not persisted", async () => {
    const adapter = new RecordingAdapter();
    const runtime = new BotRuntime(config, adapter, unusedLink(), {} as never);

    await runtime.presentRecoveredTask(task());

    expect(adapter.sent).toEqual([
      {
        replyToMessageId: "om_1",
        text: "网关重启前该任务尚未结束，当前结果未知。请先检查项目状态，再决定是否重试。",
      },
    ]);
  });

  it("updates the persisted response card when one exists", async () => {
    const adapter = new RecordingAdapter();
    const runtime = new BotRuntime(config, adapter, unusedLink(), {} as never);

    await runtime.presentRecoveredTask(task({ responseMessageId: "card_1" }));

    expect(adapter.updated).toEqual([{ messageId: "card_1" }]);
    expect(adapter.sent).toEqual([]);
  });

  it("acknowledges inbound delivery after durable acceptance without waiting for execution", async () => {
    const accepted = deferred<{ duplicate: false; task: TaskRecord }>();
    const sent = deferred<{ messageId: string }>();
    const adapter = new InboundAdapter(sent.promise);
    const store = {
      accept: () => accepted.promise,
      transitionTask: () => Promise.resolve({}),
    };
    const runtime = new BotRuntime(config, adapter, unusedLink(), store as never);
    await runtime.start();

    let acknowledged = false;
    const delivery = adapter
      .deliver({
        messageId: "om_1",
        senderId: "ou_denied",
        conversation: task().conversation,
        text: "hello",
      })
      .then(() => {
        acknowledged = true;
      });
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    accepted.resolve({ duplicate: false, task: task({ state: "accepted" }) });
    await delivery;
    expect(acknowledged).toBe(true);

    sent.resolve({ messageId: "notice_1" });
    await runtime.stop();
  });
});

const config: GatewayBotConfig = {
  id: "coding",
  agentId: "coding",
  projectDirectory: "/workspace",
  stateDirectory: "/state",
  allowUsers: ["ou_allowed"],
  concurrency: "concurrent",
  lark: {
    appId: "cli_test",
    appSecretEnv: "LARK_SECRET",
  },
  host: {
    mode: "managed",
  },
};

class RecordingAdapter implements PlatformAdapterPort {
  readonly sent: Array<{ replyToMessageId: string; text: string }> = [];
  readonly updated: Array<{ messageId: string }> = [];

  start() {
    return Promise.resolve();
  }
  sendText(target: Parameters<PlatformAdapterPort["sendText"]>[0], text: string) {
    this.sent.push({ replyToMessageId: target.replyToMessageId, text });
    return Promise.resolve({ messageId: "notice_1" });
  }
  sendCard() {
    return Promise.resolve({ messageId: "card_1" });
  }
  updateCard(messageId: string) {
    this.updated.push({ messageId });
    return Promise.resolve();
  }
  stop() {
    return Promise.resolve();
  }
}

class InboundAdapter implements PlatformAdapterPort {
  #handler?: Parameters<PlatformAdapterPort["start"]>[0];

  constructor(private readonly send: Promise<{ messageId: string }>) {}

  start(handler: Parameters<PlatformAdapterPort["start"]>[0]) {
    this.#handler = handler;
    return Promise.resolve();
  }
  deliver(message: Parameters<Parameters<PlatformAdapterPort["start"]>[0]>[0]) {
    if (!this.#handler) throw new Error("Adapter is not started");
    return this.#handler(message);
  }
  sendText() {
    return this.send;
  }
  sendCard() {
    return Promise.resolve({ messageId: "card_1" });
  }
  updateCard() {
    return Promise.resolve();
  }
  stop() {
    return Promise.resolve();
  }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    requestId: "request_1",
    platformMessageId: "om_1",
    botId: "coding",
    conversationKey: "key",
    conversation: {
      platform: "lark",
      botId: "coding",
      scope: "direct",
      chatId: "oc_1",
    },
    replyToMessageId: "om_1",
    state: "unknown",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function unusedLink(): AgentLinkPort {
  return {
    listAgents: () =>
      Promise.resolve([
        {
          id: "coding",
          displayName: "Coding",
          description: "Coding Agent",
          packageName: "@test/coding",
          packageVersion: "1.0.0",
        },
      ]),
    createConversation: () => Promise.reject(new Error("unused")),
    openConversation: () => Promise.reject(new Error("unused")),
    run: () => ({
      async *[Symbol.asyncIterator]() {},
    }),
    cancel: () => Promise.resolve(),
    closeConversation: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
