import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentLinkPort } from "../agent-link/agent-link-port";
import { GatewayStateStore } from "../persistence/gateway-state-store";
import { conversationStorageKey } from "./conversation-key";
import { ConversationRouter } from "./conversation-router";

it("rejects a changed Agent binding without opening or replacing the persisted Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-conversation-binding-"));
  try {
    const store = new GatewayStateStore(join(root, "state.json"));
    const key = { platform: "lark", botId: "bot", scope: "direct", chatId: "chat" } as const;
    const record = {
      key: conversationStorageKey(key),
      agentId: "coding",
      sessionId: "original",
      updatedAt: new Date().toISOString(),
    };
    await store.saveConversation(record);
    const link = {
      openConversation: vi.fn(async (agentId: string, sessionId: string) => ({
        agentId,
        sessionId,
      })),
      createConversation: vi.fn(),
    } satisfies Pick<AgentLinkPort, "openConversation" | "createConversation">;
    const changed = new ConversationRouter(
      "financial-analysis",
      link as unknown as AgentLinkPort,
      store,
    );
    await expect(changed.resolve(key)).rejects.toThrow(
      "stored coding, configured financial-analysis",
    );
    expect(link.openConversation).not.toHaveBeenCalled();
    expect(link.createConversation).not.toHaveBeenCalled();
    await expect(store.getConversation(record.key)).resolves.toEqual(record);
    const restored = new ConversationRouter("coding", link as unknown as AgentLinkPort, store);
    await expect(restored.resolve(key)).resolves.toEqual({
      agentId: "coding",
      sessionId: "original",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
