import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from "../session/factory";
import { AgentSessionRepository } from "../session/agent-session-repository";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(agentId = "coding") {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-session-"));
  directories.push(root);
  return { root, repository: new AgentSessionRepository({ agentId, sessionsRoot: root }) };
}

describe("session messages", () => {
  it("creates stable user and tool-result wire messages", () => {
    expect(createUserMessage("hello")).toEqual(
      expect.objectContaining({ role: "user", content: "hello" }),
    );
    expect(createToolResultMessage("call", "tool", [], false)).toEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "call", toolName: "tool" }),
    );
  });

  it("preserves assistant messages by reference", () => {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "hello" }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    expect(createAssistantMessage(message)).toBe(message);
  });
});

describe("AgentSessionRepository", () => {
  it("creates once and restores the same persisted Session", async () => {
    const { root, repository } = await fixture();
    const first = await repository.restoreLatestOrCreate();
    await repository.append(first.id, [createUserMessage("persisted")]);

    const restored = await new AgentSessionRepository({
      agentId: "coding",
      sessionsRoot: root,
    }).restoreLatestOrCreate();

    expect(restored.id).toBe(first.id);
    expect(restored.messages).toEqual([
      expect.objectContaining({ role: "user", content: "persisted" }),
    ]);
  });

  it("serializes concurrent initial restores without duplicate creation", async () => {
    const { root } = await fixture();
    const first = new AgentSessionRepository({ agentId: "coding", sessionsRoot: root });
    const second = new AgentSessionRepository({ agentId: "coding", sessionsRoot: root });

    const [firstSession, secondSession] = await Promise.all([
      first.restoreLatestOrCreate(),
      second.restoreLatestOrCreate(),
    ]);
    const index = JSON.parse(await readFile(join(root, "coding", "index.json"), "utf8")) as {
      sessions: unknown[];
    };

    expect(secondSession.id).toBe(firstSession.id);
    expect(index.sessions).toHaveLength(1);
  });

  it("isolates indexes and messages by Agent ID", async () => {
    const { root } = await fixture();
    const coding = new AgentSessionRepository({ agentId: "coding", sessionsRoot: root });
    const financial = new AgentSessionRepository({
      agentId: "financial-analysis",
      sessionsRoot: root,
    });
    const codingSession = await coding.restoreLatestOrCreate();
    const financialSession = await financial.restoreLatestOrCreate();
    await coding.append(codingSession.id, [createUserMessage("coding")]);
    await financial.append(financialSession.id, [createUserMessage("financial")]);

    await expect(financial.switchTo(codingSession.id)).rejects.toThrow("Session not found");
    expect(coding.messages).toEqual([expect.objectContaining({ content: "coding" })]);
    expect(financial.messages).toEqual([expect.objectContaining({ content: "financial" })]);
  });

  it("makes an explicitly created Session the next restored Session", async () => {
    const { root, repository } = await fixture();
    await repository.restoreLatestOrCreate();
    const created = await repository.create();
    await repository.append(created.id, [createUserMessage("new")]);

    const restored = await new AgentSessionRepository({
      agentId: "coding",
      sessionsRoot: root,
    }).restoreLatestOrCreate();

    expect(restored.id).toBe(created.id);
    expect(restored.messages).toEqual([expect.objectContaining({ content: "new" })]);
  });

  it("clears only the selected Session", async () => {
    const { repository } = await fixture();
    const session = await repository.restoreLatestOrCreate();
    await repository.append(session.id, [createUserMessage("clear me")]);
    await repository.clear(session.id);
    expect(repository.messages).toEqual([]);
  });
});
