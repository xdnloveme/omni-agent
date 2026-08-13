import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamSession } from "../stream/stream-session";
import { createStreamSession } from "../stream/factory";
import type { StreamCallbacks, StreamEvent } from "../stream/types";

function cacheReport() {
  return {
    outcome: "success" as const,
    modelCallId: "call",
    contextSnapshotId: "snapshot",
    scopeId: "scope",
    requestedRetention: "default" as const,
    appliedRetention: "short" as const,
    capability: {
      mode: "automatic_prefix" as const,
      retentions: ["none", "short"] as const,
      supportsStableScopeKey: true,
    },
    lifecycle: "cold" as const,
    commonPrefixMessageCount: 0,
    previousMessageCount: 0,
    currentMessageCount: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 10,
    inputTokens: 90,
    cacheHitRate: 0,
    createdAt: 1,
  };
}

const batch = { batchId: "batch", index: 0, total: 1 } as const;
const preview = {
  action: "execute" as const,
  resource: { kind: "command" as const, value: "ls" },
};

describe("StreamSession", () => {
  let callbacks: Required<StreamCallbacks>;
  let session: StreamSession;

  beforeEach(() => {
    callbacks = {
      onTextChunk: vi.fn(),
      onModelContextPrepared: vi.fn(),
      onModelCacheReport: vi.fn(),
      onContextProgress: vi.fn(),
      onToolBatchStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onToolBatchEnd: vi.fn(),
      onExtensionEvent: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    session = new StreamSession(callbacks);
  });

  describe("initial state", () => {
    it("starts in idle state", () => {
      expect(session.state).toBe("idle");
    });

    it("has no accumulated messages", () => {
      expect(session.getAccumulatedMessages()).toEqual([]);
    });

    it("has empty accumulated text", () => {
      expect(session.getAccumulatedText()).toBe("");
    });
  });

  describe("text_delta events", () => {
    it("transitions to streaming on first text_delta", () => {
      session.handle({ type: "text_delta", delta: "Hello" });
      expect(session.state).toBe("streaming");
    });

    it("calls onTextChunk callback", () => {
      session.handle({ type: "text_delta", delta: "Hello" });
      expect(callbacks.onTextChunk).toHaveBeenCalledWith("Hello");
    });

    it("accumulates text across multiple deltas", () => {
      session.handle({ type: "text_delta", delta: "Hello " });
      session.handle({ type: "text_delta", delta: "world" });
      expect(session.getAccumulatedText()).toBe("Hello world");
    });

    it("records each delta as an accumulated message", () => {
      session.handle({ type: "text_delta", delta: "Hi" });
      const msgs = session.getAccumulatedMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("text");
      expect(msgs[0].content).toBe("Hi");
    });
  });

  describe("model context events", () => {
    it("notifies observers without accumulating a conversation message", () => {
      const manifest = {
        snapshotId: "snapshot",
        modelCallId: "call",
        agentId: "coding",
        sessionId: "session",
        sessionRevision: 1,
        policyStages: [],
        middleware: [],
        sourceMessageCount: 1,
        outputMessageCount: 1,
        sourceDigest: "source",
        contextEntryDigest: "entries",
        outputDigest: "output",
        systemPromptDigest: "system",
        toolsetDigest: "tools",
        estimatedInputTokens: 1,
        usableInputBudget: 100,
        usageRatio: 0.01,
        artifactIds: [],
        decisions: [],
        createdAt: 1,
      };

      session.handle({ type: "model_context_prepared", manifest });

      expect(callbacks.onModelContextPrepared).toHaveBeenCalledWith(manifest);
      expect(session.getAccumulatedMessages()).toEqual([]);
      expect(session.state).toBe("idle");
    });
  });

  describe("model cache events", () => {
    it("notifies observers without accumulating a conversation message", () => {
      const report = cacheReport();

      session.handle({ type: "model_cache_report", report });

      expect(callbacks.onModelCacheReport).toHaveBeenCalledWith(report);
      expect(session.getAccumulatedMessages()).toEqual([]);
      expect(session.state).toBe("idle");
    });
  });

  describe("context progress events", () => {
    it("notifies observers without accumulating a conversation message", () => {
      const event = {
        type: "compression_started" as const,
        compressionId: "compression",
        modelCallId: "call",
        beforeTokens: 100,
        startedKind: "artifact_projection" as const,
      };
      session.handle({ type: "context_progress", event });
      expect(callbacks.onContextProgress).toHaveBeenCalledWith(event);
      expect(session.getAccumulatedMessages()).toEqual([]);
    });

    it("isolates observer failures", () => {
      vi.mocked(callbacks.onContextProgress).mockImplementation(() => {
        throw new Error("renderer failed");
      });
      expect(() =>
        session.handle({
          type: "context_progress",
          event: {
            type: "compression_started",
            compressionId: "compression",
            modelCallId: "call",
            beforeTokens: 100,
            startedKind: "heavy_checkpoint",
          },
        }),
      ).not.toThrow();
    });
  });

  describe("tool_use_start events", () => {
    it("transitions to streaming", () => {
      session.handle({
        type: "tool_use_start",
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "ls" },
        preview,
        batch,
      });
      expect(session.state).toBe("streaming");
    });

    it("calls onToolStart callback with correct args", () => {
      session.handle({
        type: "tool_use_start",
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "ls" },
        preview,
        batch,
      });
      expect(callbacks.onToolStart).toHaveBeenCalledWith({
        type: "tool_use_start",
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "ls" },
        preview,
        batch,
      });
    });

    it("records tool_call in accumulated messages", () => {
      session.handle({
        type: "tool_use_start",
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "ls" },
        preview,
        batch,
      });
      const msgs = session.getAccumulatedMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool_call");
      expect(msgs[0].content).toBe("bash");
      expect(msgs[0].meta).toEqual({
        toolCallId: "call_1",
        input: { command: "ls" },
        preview,
        batch,
      });
    });
  });

  describe("tool_use_end events", () => {
    it("calls onToolEnd callback with correct args", () => {
      const result = { content: [{ type: "text" as const, text: "output" }], isError: false };
      session.handle({
        type: "tool_use_end",
        toolName: "bash",
        toolCallId: "call_1",
        result,
        durationMs: 150,
        batch,
      });
      expect(callbacks.onToolEnd).toHaveBeenCalledWith({
        type: "tool_use_end",
        toolName: "bash",
        toolCallId: "call_1",
        result,
        durationMs: 150,
        batch,
      });
    });

    it("records tool_result in accumulated messages", () => {
      session.handle({
        type: "tool_use_end",
        toolName: "bash",
        toolCallId: "call_1",
        result: { content: [{ type: "text", text: "output" }], isError: false },
        durationMs: 100,
        batch,
      });
      const msgs = session.getAccumulatedMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("tool_result");
      expect(msgs[0].content).toBe("output");
    });

    it("detaches callback data from the runtime event", () => {
      const result = {
        content: [{ type: "text" as const, text: "original" }],
        isError: false,
        meta: { presentation: { resource: { kind: "file" as const, path: "/workspace/a.ts" } } },
      };
      vi.mocked(callbacks.onToolEnd).mockImplementation((event) => {
        event.result.content[0].text = "mutated";
        (event.result.meta!.presentation!.resource as { path: string }).path = "/mutated";
      });
      session.handle({
        type: "tool_use_end",
        toolName: "file_read",
        toolCallId: "call_1",
        result,
        durationMs: 1,
        batch,
      });
      expect(result.content[0].text).toBe("original");
      expect(result.meta.presentation.resource.path).toBe("/workspace/a.ts");
    });
  });

  describe("done event", () => {
    it("transitions to done state", () => {
      session.handle({ type: "text_delta", delta: "Hi" });
      session.handle({ type: "done" });
      expect(session.state).toBe("done");
    });

    it("calls onDone callback", () => {
      session.handle({ type: "done" });
      expect(callbacks.onDone).toHaveBeenCalled();
    });
  });

  describe("error event", () => {
    it("transitions to error state", () => {
      session.handle({ type: "error", error: "something broke" });
      expect(session.state).toBe("error");
    });

    it("calls onError callback", () => {
      session.handle({ type: "error", error: "something broke" });
      expect(callbacks.onError).toHaveBeenCalledWith("something broke");
    });

    it("records error in accumulated messages", () => {
      session.handle({ type: "error", error: "fail" });
      const msgs = session.getAccumulatedMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("[error] fail");
    });
  });

  describe("reset", () => {
    it("resets state to idle", () => {
      session.handle({ type: "text_delta", delta: "Hi" });
      session.handle({ type: "done" });
      session.reset();
      expect(session.state).toBe("idle");
    });

    it("clears accumulated messages", () => {
      session.handle({ type: "text_delta", delta: "Hi" });
      session.reset();
      expect(session.getAccumulatedMessages()).toEqual([]);
    });

    it("clears accumulated text", () => {
      session.handle({ type: "text_delta", delta: "Hi" });
      session.reset();
      expect(session.getAccumulatedText()).toBe("");
    });
  });

  describe("full lifecycle", () => {
    it("handles a complete text-only session", () => {
      session.handle({ type: "text_delta", delta: "Hello " });
      session.handle({ type: "text_delta", delta: "world!" });
      session.handle({ type: "done" });

      expect(session.state).toBe("done");
      expect(session.getAccumulatedText()).toBe("Hello world!");
      expect(callbacks.onTextChunk).toHaveBeenCalledTimes(2);
      expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    });

    it("handles a session with tool calls", () => {
      session.handle({
        type: "tool_use_start",
        toolName: "bash",
        toolCallId: "c1",
        input: { cmd: "ls" },
        preview,
        batch,
      });
      session.handle({
        type: "tool_use_end",
        toolName: "bash",
        toolCallId: "c1",
        result: { content: [{ type: "text", text: "file.txt" }], isError: false },
        durationMs: 50,
        batch,
      });
      session.handle({ type: "text_delta", delta: "Found file.txt" });
      session.handle({ type: "done" });

      expect(session.state).toBe("done");
      // tool_call + tool_result + text_delta = 3 messages (done doesn't accumulate)
      expect(session.getAccumulatedMessages()).toHaveLength(3);
      expect(callbacks.onToolStart).toHaveBeenCalledTimes(1);
      expect(callbacks.onToolEnd).toHaveBeenCalledTimes(1);
      expect(callbacks.onTextChunk).toHaveBeenCalledTimes(1);
      expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createStreamSession", () => {
  it("creates a StreamSession instance", () => {
    const session = createStreamSession();
    expect(session).toBeInstanceOf(StreamSession);
    expect(session.state).toBe("idle");
  });

  it("creates a session with callbacks", () => {
    const onTextChunk = vi.fn();
    const session = createStreamSession({ onTextChunk });
    session.handle({ type: "text_delta", delta: "test" });
    expect(onTextChunk).toHaveBeenCalledWith("test");
  });

  it("works with partial callbacks (only some provided)", () => {
    const onDone = vi.fn();
    const session = createStreamSession({ onDone });
    // Should not throw when other events fire without callbacks
    session.handle({ type: "text_delta", delta: "test" });
    session.handle({ type: "done" });
    expect(onDone).toHaveBeenCalled();
  });
});
