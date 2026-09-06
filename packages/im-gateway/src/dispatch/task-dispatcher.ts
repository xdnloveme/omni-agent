import type { InboundMessage } from "../contracts";
import { isAbortError } from "@omni-agent/core";
import type { AgentLinkPort } from "../agent-link/agent-link-port";
import type { AgentLinkEvent } from "../agent-link/agent-link-events";
import type { GatewayStateStore } from "../persistence/gateway-state-store";
import type { ConversationRouter } from "../routing/conversation-router";
import type { ConcurrencyPolicy } from "./concurrency-policy";

export interface TaskDispatchCallbacks {
  onQueued?(position: number): Promise<void> | void;
  onConflict?(): Promise<void> | void;
  onEvent(event: AgentLinkEvent): Promise<void> | void;
}

interface ActiveTask {
  readonly conversationKey: string;
  readonly controller: AbortController;
  running: boolean;
}

export class TaskDispatcher {
  readonly #active = new Map<string, ActiveTask>();
  #shuttingDown = false;

  constructor(
    private readonly link: AgentLinkPort,
    private readonly router: ConversationRouter,
    private readonly store: GatewayStateStore,
    private readonly policy: ConcurrencyPolicy,
  ) {}

  async dispatch(
    message: InboundMessage,
    requestId: string,
    callbacks: TaskDispatchCallbacks,
  ): Promise<void> {
    const controller = new AbortController();
    if (this.#shuttingDown) controller.abort();
    const trackedTask: ActiveTask = {
      conversationKey: message.conversation.chatId,
      controller,
      running: false,
    };
    this.#active.set(requestId, trackedTask);
    let permit: Awaited<ReturnType<ConcurrencyPolicy["acquire"]>> | undefined;
    try {
      const hadConflict = this.policy.active > 0;
      const queuePosition = this.policy.queued + 1;
      if (hadConflict) {
        if (this.policy.serial) {
          await this.store.transitionTask(requestId, "queued");
          await callbacks.onQueued?.(queuePosition);
        } else {
          await callbacks.onConflict?.();
        }
      }
      permit = await this.policy.acquire(controller.signal);
      trackedTask.running = true;
      await this.store.transitionTask(requestId, "running");
      const handle = await this.router.resolve(message.conversation);
      let terminal = false;
      for await (const event of this.link.run(handle, requestId, message.text, controller.signal)) {
        await callbacks.onEvent(event);
        if (event.type === "completed") {
          terminal = true;
          await this.store.transitionTask(requestId, "completed");
        } else if (event.type === "failed") {
          terminal = true;
          await this.store.transitionTask(requestId, "failed", { failureCode: event.code });
        } else if (event.type === "cancelled") {
          terminal = true;
          await this.store.transitionTask(requestId, "cancelled");
        } else if (event.type === "unknown") {
          terminal = true;
          await this.store.transitionTask(requestId, "unknown");
        }
      }
      if (!terminal) await this.store.transitionTask(requestId, "unknown");
    } catch (error) {
      if (isAbortError(error, controller.signal)) {
        await this.store.transitionTask(requestId, "cancelled");
        await callbacks.onEvent({ type: "cancelled" });
        return;
      }
      await this.store.transitionTask(requestId, "failed", {
        failureCode: error instanceof Error ? error.name : "dispatch_failed",
      });
      throw error;
    } finally {
      this.#active.delete(requestId);
      permit?.release();
    }
  }

  async stopConversation(chatId: string): Promise<boolean> {
    const candidate = [...this.#active.entries()].find(
      ([, active]) => active.running && active.conversationKey === chatId,
    );
    if (!candidate) return false;
    const [, active] = candidate;
    active.controller.abort();
    return true;
  }

  shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const active of this.#active.values()) active.controller.abort();
  }
}
