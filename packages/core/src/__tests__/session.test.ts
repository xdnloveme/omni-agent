import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Use vi.hoisted to define TEST_HOME before vi.mock hoisting
const { TEST_HOME, SESSIONS_DIR } = vi.hoisted(() => {
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { randomUUID } = require("node:crypto");
  const TEST_HOME = join(tmpdir(), `omni-agent-test-${randomUUID()}`);
  const SESSIONS_DIR = join(TEST_HOME, ".omni-agent", "sessions");
  return { TEST_HOME, SESSIONS_DIR };
});

// We need to mock the home directory to avoid polluting the real filesystem
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
} from "../session/factory";
import { FileSessionStore } from "../session/session-store";
import { SessionManager } from "../session/session-manager";
import type { SessionIndex, SessionEntry } from "../session/types";

describe("session/factory", () => {
  it("createUserMessage produces a valid user message", () => {
    const msg = createUserMessage("Hello");
    expect(msg.role).toBe("user");
    expect(msg).toHaveProperty("content", "Hello");
    expect(msg).toHaveProperty("timestamp");
    expect(typeof (msg as any).timestamp).toBe("number");
  });

  it("createAssistantMessage passes through the AssistantMessage", () => {
    const assistantMsg = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Hi there" }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "claude-3",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    const msg = createAssistantMessage(assistantMsg);
    expect(msg).toBe(assistantMsg); // same reference
  });

  it("createToolResultMessage produces a valid tool result message", () => {
    const msg = createToolResultMessage(
      "call_123",
      "bash",
      [{ type: "text", text: "output" }],
      false,
    );
    expect(msg.role).toBe("toolResult");
    if (msg.role === "toolResult") {
      expect(msg.toolCallId).toBe("call_123");
      expect(msg.toolName).toBe("bash");
      expect(msg.content).toEqual([{ type: "text", text: "output" }]);
      expect(msg.isError).toBe(false);
      expect(typeof msg.timestamp).toBe("number");
    }
  });

  it("createToolResultMessage with isError=true", () => {
    const msg = createToolResultMessage(
      "call_456",
      "file_read",
      [{ type: "text", text: "File not found" }],
      true,
    );
    if (msg.role === "toolResult") {
      expect(msg.isError).toBe(true);
    }
  });
});

describe("session/session-store", () => {
  let store: FileSessionStore;

  beforeEach(() => {
    // Clean up test directory
    if (existsSync(SESSIONS_DIR)) {
      rmSync(SESSIONS_DIR, { recursive: true });
    }
    mkdirSync(SESSIONS_DIR, { recursive: true });
    store = new FileSessionStore(SESSIONS_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true });
    }
  });

  describe("readIndex / writeIndex", () => {
    it("returns empty index when file does not exist", () => {
      // Remove the index file if it exists
      const indexPath = join(SESSIONS_DIR, "index.json");
      if (existsSync(indexPath)) rmSync(indexPath);

      const index = store.readIndex();
      expect(index.sessions).toEqual([]);
    });

    it("writes and reads back an index", () => {
      const index: SessionIndex = {
        sessions: [{ id: "abc-123", createdAt: 1000, lastActiveAt: 2000 }],
      };
      store.writeIndex(index);
      const result = store.readIndex();
      expect(result).toEqual(index);
    });
  });

  describe("upsertIndexEntry", () => {
    it("adds a new entry", () => {
      const entry: SessionEntry = { id: "new-id", createdAt: 100, lastActiveAt: 200 };
      store.upsertIndexEntry(entry);
      const index = store.readIndex();
      expect(index.sessions).toHaveLength(1);
      expect(index.sessions[0]).toEqual(entry);
    });

    it("updates an existing entry", () => {
      const entry: SessionEntry = { id: "existing", createdAt: 100, lastActiveAt: 200 };
      store.upsertIndexEntry(entry);
      store.upsertIndexEntry({ ...entry, lastActiveAt: 500 });
      const index = store.readIndex();
      expect(index.sessions).toHaveLength(1);
      expect(index.sessions[0].lastActiveAt).toBe(500);
    });
  });

  describe("appendMessage / replayMessages", () => {
    it("appends and replays messages", () => {
      const sessionId = "test-session";
      store.upsertIndexEntry({ id: sessionId, createdAt: 100, lastActiveAt: 100 });

      const msg1 = createUserMessage("Hello");
      const msg2 = createUserMessage("World");

      store.appendMessage(sessionId, msg1);
      store.appendMessage(sessionId, msg2);

      const replayed = store.replayMessages(sessionId);
      expect(replayed).toHaveLength(2);
      expect(replayed[0].role).toBe("user");
      expect(replayed[1].role).toBe("user");
    });

    it("returns empty array for non-existent session", () => {
      const replayed = store.replayMessages("nonexistent");
      expect(replayed).toEqual([]);
    });
  });

  describe("appendMessages (batch)", () => {
    it("appends multiple messages at once", () => {
      const sessionId = "batch-session";
      store.upsertIndexEntry({ id: sessionId, createdAt: 100, lastActiveAt: 100 });

      const msgs = [createUserMessage("One"), createUserMessage("Two"), createUserMessage("Three")];

      store.appendMessages(sessionId, msgs);

      const replayed = store.replayMessages(sessionId);
      expect(replayed).toHaveLength(3);
    });

    it("does nothing for empty array", () => {
      const sessionId = "empty-batch";
      store.upsertIndexEntry({ id: sessionId, createdAt: 100, lastActiveAt: 100 });
      store.appendMessages(sessionId, []);
      const replayed = store.replayMessages(sessionId);
      expect(replayed).toEqual([]);
    });
  });

  describe("clearSession", () => {
    it("clears the JSONL file content", () => {
      const sessionId = "clear-test";
      store.upsertIndexEntry({ id: sessionId, createdAt: 100, lastActiveAt: 100 });
      store.appendMessage(sessionId, createUserMessage("Hello"));

      store.clearSession(sessionId);

      const replayed = store.replayMessages(sessionId);
      expect(replayed).toEqual([]);
    });
  });

  describe("removeSession", () => {
    it("removes the JSONL file and index entry", () => {
      const sessionId = "remove-test";
      store.upsertIndexEntry({ id: sessionId, createdAt: 100, lastActiveAt: 100 });
      store.appendMessage(sessionId, createUserMessage("Hello"));

      store.removeSession(sessionId);

      const index = store.readIndex();
      expect(index.sessions.find((s) => s.id === sessionId)).toBeUndefined();
      expect(existsSync(join(SESSIONS_DIR, `${sessionId}.jsonl`))).toBe(false);
    });
  });
});

describe("session/SessionManager", () => {
  let manager: SessionManager;
  let store: FileSessionStore;

  beforeEach(() => {
    if (existsSync(SESSIONS_DIR)) {
      rmSync(SESSIONS_DIR, { recursive: true });
    }
    mkdirSync(SESSIONS_DIR, { recursive: true });
    store = new FileSessionStore(SESSIONS_DIR);
    manager = new SessionManager(store);
  });

  afterEach(() => {
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true });
    }
  });

  describe("create", () => {
    it("creates a new session with a UUID", () => {
      const id = manager.create();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(manager.currentId).toBe(id);
      expect(manager.messages).toEqual([]);
    });

    it("registers the session in the index", () => {
      const id = manager.create();
      const index = store.readIndex();
      expect(index.sessions.find((s) => s.id === id)).toBeDefined();
    });
  });

  describe("restoreLatest", () => {
    it("creates a new session when no sessions exist", () => {
      const id = manager.restoreLatest();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(manager.messages).toEqual([]);
    });

    it("restores the most recently active session", () => {
      // Create two sessions with different lastActiveAt
      const oldId = "old-session";
      const newId = "new-session";
      store.upsertIndexEntry({ id: oldId, createdAt: 100, lastActiveAt: 100 });
      store.upsertIndexEntry({ id: newId, createdAt: 200, lastActiveAt: 300 });

      // Write a message to the newer session
      store.appendMessage(newId, createUserMessage("Latest"));

      const restoredId = manager.restoreLatest();
      expect(restoredId).toBe(newId);
      expect(manager.messages).toHaveLength(1);
    });
  });

  describe("append", () => {
    it("appends a message to memory and disk", () => {
      manager.create();
      const msg = createUserMessage("Test");
      manager.append(msg);

      expect(manager.messages).toHaveLength(1);
      expect(manager.messages[0]).toBe(msg);

      // Verify on disk
      const replayed = store.replayMessages(manager.currentId!);
      expect(replayed).toHaveLength(1);
    });

    it("throws if no active session", () => {
      expect(() => manager.append(createUserMessage("x"))).toThrow("No active session");
    });
  });

  describe("appendBatch", () => {
    it("appends multiple messages at once", () => {
      manager.create();
      const msgs = [createUserMessage("A"), createUserMessage("B")];
      manager.appendBatch(msgs);

      expect(manager.messages).toHaveLength(2);
      const replayed = store.replayMessages(manager.currentId!);
      expect(replayed).toHaveLength(2);
    });
  });

  describe("clear", () => {
    it("clears messages in memory and on disk", () => {
      manager.create();
      manager.append(createUserMessage("Hello"));
      manager.clear();

      expect(manager.messages).toEqual([]);
      const replayed = store.replayMessages(manager.currentId!);
      expect(replayed).toEqual([]);
    });

    it("throws if no active session", () => {
      expect(() => manager.clear()).toThrow("No active session");
    });
  });

  describe("switchTo", () => {
    it("switches to an existing session", () => {
      const id1 = manager.create();
      manager.append(createUserMessage("Session 1"));

      const id2 = manager.create();
      manager.append(createUserMessage("Session 2"));

      manager.switchTo(id1);
      expect(manager.currentId).toBe(id1);
      expect(manager.messages).toHaveLength(1);
      if (manager.messages[0].role === "user") {
        expect(manager.messages[0].content).toBe("Session 1");
      }
    });

    it("throws for non-existent session", () => {
      expect(() => manager.switchTo("nonexistent")).toThrow("Session not found");
    });
  });
});
