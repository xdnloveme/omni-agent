import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../contracts";
import { GatewayStateStore } from "./gateway-state-store";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GatewayStateStore", () => {
  it("deduplicates a platform message and keeps its first request", async () => {
    const store = await createStore();
    const first = await store.accept(message());
    const duplicate = await store.accept(message());

    expect(first.duplicate).toBe(false);
    expect(duplicate).toEqual({ duplicate: true, task: first.task });
  });

  it("marks non-terminal tasks unknown on restart", async () => {
    const store = await createStore();
    const accepted = await store.accept(message());
    await store.transitionTask(accepted.task.requestId, "running");

    const recovered = await store.recoverUnknown();

    expect(recovered).toMatchObject([{ requestId: accepted.task.requestId, state: "unknown" }]);
    expect(recovered[0]).toMatchObject({
      conversation: message().conversation,
      replyToMessageId: message().messageId,
      recoveryNoticePending: true,
    });
    await expect(store.recoverUnknown()).resolves.toMatchObject([
      { requestId: accepted.task.requestId, recoveryNoticePending: true },
    ]);
    await store.markRecoveryNoticePresented(accepted.task.requestId);
    await expect(store.recoverUnknown()).resolves.toEqual([]);
  });

  it("expires terminal tasks together with their deduplication keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = await createStore(1_000);
    const first = await store.accept(message());
    await store.transitionTask(first.task.requestId, "completed");
    vi.advanceTimersByTime(1_001);

    await store.accept({ ...message(), messageId: "om_2", eventId: "event_2" });
    const replayAfterRetention = await store.accept(message());

    expect(replayAfterRetention.duplicate).toBe(false);
    expect(replayAfterRetention.task.requestId).not.toBe(first.task.requestId);
  });
});

async function createStore(retentionMs?: number): Promise<GatewayStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "omni-im-state-"));
  directories.push(directory);
  return new GatewayStateStore(join(directory, "gateway.json"), retentionMs);
}

function message(): InboundMessage {
  return {
    messageId: "om_1",
    eventId: "event_1",
    senderId: "ou_allowed",
    conversation: {
      platform: "lark",
      botId: "coding",
      scope: "direct",
      chatId: "oc_1",
    },
    text: "hello",
  };
}
