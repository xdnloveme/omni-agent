import { describe, expect, it } from "vitest";
import type { AgentConversationHandle, AgentLinkPort } from "../agent-link/agent-link-port";
import type { AgentLinkEvent } from "../agent-link/agent-link-events";
import type { InboundMessage } from "../contracts";
import { ConcurrentPolicy, SerialPolicy } from "./concurrency-policy";
import { TaskDispatcher } from "./task-dispatcher";

describe("TaskDispatcher", () => {
  it("cancels the active request in the selected conversation", async () => {
    const controller = new AbortController();
    const link = new BlockingLink(controller);
    const message = inbound();
    const store = new MemoryStore();
    const dispatcher = new TaskDispatcher(
      link,
      { resolve: async () => ({ agentId: "coding", sessionId: "session" }) } as never,
      store as never,
      new ConcurrentPolicy(),
    );

    const run = dispatcher.dispatch(message, "request", { onEvent: () => undefined });
    await new Promise<void>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await expect(dispatcher.stopConversation("oc_1")).resolves.toBe(true);
    await run;

    expect(store.states).toContain("cancelled");
  });

  it("cancels active and queued work during shutdown", async () => {
    const link = new ShutdownLink();
    const store = new MemoryStore();
    const dispatcher = new TaskDispatcher(
      link,
      { resolve: async () => ({ agentId: "coding", sessionId: "session" }) } as never,
      store as never,
      new SerialPolicy(),
    );
    const first = dispatcher.dispatch(inbound(), "first", { onEvent: () => undefined });
    await link.started;
    const second = dispatcher.dispatch({ ...inbound(), messageId: "om_2" }, "second", {
      onEvent: () => undefined,
    });

    dispatcher.shutdown();
    await Promise.all([first, second]);

    expect(store.requests.get("first")).toContain("cancelled");
    expect(store.requests.get("second")).toContain("cancelled");
  });
});

describe("SerialPolicy", () => {
  it("hands the permit to the next waiter when a selected waiter is cancelled", async () => {
    const policy = new SerialPolicy();
    const first = await policy.acquire();
    const cancelled = new AbortController();
    const second = policy.acquire(cancelled.signal);
    const third = policy.acquire();

    first.release();
    cancelled.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    const permit = await third;
    expect(policy.active).toBe(1);
    expect(policy.queued).toBe(0);
    permit.release();
    expect(policy.active).toBe(0);
  });
});

class BlockingLink implements AgentLinkPort {
  constructor(private readonly started: AbortController) {}
  listAgents() {
    return Promise.resolve([]);
  }
  createConversation(): Promise<AgentConversationHandle> {
    throw new Error("unused");
  }
  openConversation(): Promise<AgentConversationHandle> {
    throw new Error("unused");
  }
  async *run(
    _handle: AgentConversationHandle,
    _requestId: string,
    _text: string,
    signal?: AbortSignal,
  ): AsyncIterable<AgentLinkEvent> {
    this.started.abort();
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield { type: "cancelled" };
  }
  cancel() {
    return Promise.resolve();
  }
  closeConversation() {
    return Promise.resolve();
  }
  dispose() {
    return Promise.resolve();
  }
}

class MemoryStore {
  readonly states: string[] = [];
  readonly requests = new Map<string, string[]>();
  transitionTask(requestId: string, state: string) {
    this.states.push(state);
    const states = this.requests.get(requestId) ?? [];
    states.push(state);
    this.requests.set(requestId, states);
    return Promise.resolve({});
  }
}

class ShutdownLink implements AgentLinkPort {
  readonly started: Promise<void>;
  #resolveStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  listAgents() {
    return Promise.resolve([]);
  }
  createConversation(): Promise<AgentConversationHandle> {
    throw new Error("unused");
  }
  openConversation(): Promise<AgentConversationHandle> {
    throw new Error("unused");
  }
  async *run(
    _handle: AgentConversationHandle,
    _requestId: string,
    _text: string,
    signal?: AbortSignal,
  ): AsyncIterable<AgentLinkEvent> {
    this.#resolveStarted();
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield { type: "cancelled" };
  }
  cancel() {
    return Promise.resolve();
  }
  closeConversation() {
    return Promise.resolve();
  }
  dispose() {
    return Promise.resolve();
  }
}

function inbound(): InboundMessage {
  return {
    messageId: "om_1",
    senderId: "ou_1",
    conversation: {
      platform: "lark",
      botId: "coding",
      scope: "direct",
      chatId: "oc_1",
    },
    text: "hello",
  };
}
