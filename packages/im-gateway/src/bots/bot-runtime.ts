import type { InboundMessage, PlatformMessageTarget, TaskRecord } from "../contracts";
import type { AgentLinkPort } from "../agent-link/agent-link-port";
import type { GatewayBotConfig } from "../config/gateway-config";
import { Allowlist } from "../admission/allowlist";
import { ConcurrentPolicy, SerialPolicy } from "../dispatch/concurrency-policy";
import { TaskDispatcher } from "../dispatch/task-dispatcher";
import type { GatewayStateStore } from "../persistence/gateway-state-store";
import type { PlatformAdapterPort } from "../platform/platform-port";
import { presentFailure } from "../presentation/failure-presenter";
import { CardStreamPresenter } from "../presentation/card-stream-presenter";
import { StreamAggregator } from "../presentation/stream-aggregator";
import { ConversationRouter } from "../routing/conversation-router";

export class BotRuntime {
  readonly #allowlist: Allowlist;
  readonly #dispatcher: TaskDispatcher;
  readonly #receives = new Set<Promise<void>>();
  #started = false;

  get started(): boolean {
    return this.#started;
  }

  constructor(
    readonly config: GatewayBotConfig,
    private readonly adapter: PlatformAdapterPort,
    private readonly link: AgentLinkPort,
    private readonly store: GatewayStateStore,
  ) {
    this.#allowlist = new Allowlist(config.allowUsers);
    const router = new ConversationRouter(config.agentId, link, store);
    const policy = config.concurrency === "serial" ? new SerialPolicy() : new ConcurrentPolicy();
    this.#dispatcher = new TaskDispatcher(link, router, store, policy);
  }

  async dispose(): Promise<void> {
    try {
      await this.link.dispose();
    } finally {
      await this.#waitForReceives(500);
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    try {
      const agents = await this.link.listAgents();
      if (!agents.some((agent) => agent.id === this.config.agentId)) {
        throw new Error(`Configured Agent is unavailable: ${this.config.agentId}`);
      }
      await this.adapter.start((message) => this.#accept(message));
    } catch (error) {
      this.#started = false;
      await this.adapter.stop().catch(() => undefined);
      await this.link.dispose().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    try {
      await this.adapter.stop();
    } finally {
      this.#dispatcher.shutdown();
      await this.#waitForReceives(2_000);
    }
  }

  async presentRecoveredTask(task: TaskRecord): Promise<void> {
    if (task.botId !== this.config.id) return;
    const message = "网关重启前该任务尚未结束，当前结果未知。请先检查项目状态，再决定是否重试。";
    if (task.responseMessageId) {
      await this.adapter.updateCard(task.responseMessageId, message);
      return;
    }
    await this.adapter.sendText(
      {
        conversation: task.conversation,
        replyToMessageId: task.replyToMessageId,
      },
      message,
    );
  }

  async #accept(message: InboundMessage): Promise<void> {
    const accepted = await this.store.accept(message);
    if (accepted.duplicate) return;
    const operation = this.#process(message, accepted.task);
    this.#receives.add(operation);
    void operation.catch((error) => {
      process.stderr.write(
        `[im-gateway:${this.config.id}] ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    void operation.finally(() => this.#receives.delete(operation)).catch(() => undefined);
  }

  async #process(message: InboundMessage, task: TaskRecord): Promise<void> {
    const target: PlatformMessageTarget = {
      conversation: message.conversation,
      replyToMessageId: message.messageId,
    };
    if (!this.#allowlist.allows(message.senderId)) {
      await this.store.transitionTask(task.requestId, "rejected", {
        failureCode: "not_allowed",
      });
      await this.adapter.sendText(target, "你不在该机器人的使用白名单中。");
      return;
    }
    if (message.text === "/stop") {
      const stopped = await this.#dispatcher.stopConversation(message.conversation.chatId);
      await this.store.transitionTask(task.requestId, "completed");
      await this.adapter.sendText(
        target,
        stopped ? "已请求停止当前任务。" : "当前会话没有运行中的任务。",
      );
      return;
    }

    let response: { messageId: string };
    try {
      response = await this.adapter.sendCard(target, "处理中…");
      await this.store.transitionTask(task.requestId, "accepted", {
        responseMessageId: response.messageId,
      });
    } catch (error) {
      await this.store.transitionTask(task.requestId, "failed", {
        failureCode: "presentation_setup_failed",
      });
      throw error;
    }
    const cardPresenter = new CardStreamPresenter(response.messageId, target, this.adapter);
    const aggregator = new StreamAggregator({
      update: (text) => cardPresenter.update(text),
    });
    let finalText = "";
    try {
      await this.#dispatcher.dispatch(message, task.requestId, {
        onQueued: (position) => {
          aggregator.replace(`前面还有 ${position} 个任务，当前任务已排队。`);
        },
        onConflict: () => {
          aggregator.replace("检测到同一机器人还有任务运行；当前任务将并发执行，请注意文件冲突。");
        },
        onEvent: (event) => {
          if (event.type === "text_delta") {
            finalText += event.text;
            aggregator.append(event.text);
          } else if (event.type === "final_response") {
            finalText = event.text;
            aggregator.replace(event.text);
          } else if (event.type === "failed") {
            aggregator.replace(presentFailure(event));
          } else if (event.type === "cancelled") {
            aggregator.replace("任务已停止。");
          } else if (event.type === "unknown") {
            aggregator.replace("Agent 连接已中断，任务结果未知，请检查项目状态后再继续。");
          } else if (event.type === "completed" && !finalText) {
            aggregator.replace("任务已完成。");
          }
        },
      });
    } catch (error) {
      aggregator.replace(`任务失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        await aggregator.close();
      } catch (error) {
        await this.adapter.sendText(
          target,
          "任务已经结束，但结果卡片更新失败。请稍后重试，或到终端检查任务结果。",
        );
        process.stderr.write(
          `[im-gateway:${this.config.id}] result card update failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
  }

  async #waitForReceives(timeoutMs: number): Promise<void> {
    if (this.#receives.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.#receives]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
