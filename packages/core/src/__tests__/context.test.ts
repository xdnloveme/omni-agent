import { describe, expect, it, vi } from "vitest";
import {
  ApproximateContextTokenEstimator,
  ContextPolicyPipeline,
  DefaultContextEngine,
  InvalidContextPolicyResultError,
  type ContextMiddlewarePort,
  type ContextFinalGatePort,
  type ContextPolicyStagePort,
} from "../context";
import { createContextPreparationRequest } from "../agent/contextInput";
import { WorkingConversation } from "../agent/workingConversation";
import { createContextDraft } from "../context/assembly/draft";
import type { TranscriptMessage } from "../messages";
import type { RegisteredAgentTool } from "../types";

function messages(): TranscriptMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "inspect" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "inspect",
          arguments: { path: "README.md", range: { start: 1, end: 10 } },
        },
      ],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      diagnostics: [{ type: "trace", timestamp: 2, details: { nested: { value: 1 } } }],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "inspect",
      content: [{ type: "text", text: "result" }],
      details: { source: { line: 1 } },
      isError: false,
      timestamp: 3,
    },
  ];
}

function tool(): RegisteredAgentTool {
  return {
    name: "inspect",
    description: "Inspect a file",
    schema: {
      type: "object",
      properties: { path: { type: "string", metadata: { source: "model" } } },
    },
    strict: true,
    originId: "test",
    toolIdentity: "test:inspect",
    authorization: { kind: "static", risk: "read", reason: "test" },
    execution: { kind: "host" },
    timeout: { kind: "none" },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
}

function request(middleware: readonly ContextMiddlewarePort[] = [], sourceMessages = messages()) {
  const conversation = WorkingConversation.from({
    sessionId: "session-1",
    revision: 4,
    messages: sourceMessages,
  });
  return {
    conversation,
    preparation: createContextPreparationRequest({
      identity: {
        agentId: "coding",
        sessionId: "session-1",
        sessionRevision: 4,
        modelCallId: "model-call-1",
      },
      conversation: conversation.snapshot(),
      systemPrompt: "system",
      tools: [tool()],
      model: { modelId: "test-model", contextWindow: 128_000, maxOutputTokens: 4_096 },
      middleware,
      progress: { publish() {} },
    }),
  };
}

function createEngine(stages: readonly ContextPolicyStagePort[] = []) {
  return new DefaultContextEngine(
    new ContextPolicyPipeline(stages, finalGate(), new ApproximateContextTokenEstimator()),
  );
}

function finalGate(): ContextFinalGatePort {
  return {
    name: "test_final_gate",
    version: 1,
    async apply(frame) {
      return { frame: structuredClone(frame) as never, decisions: [] };
    },
  };
}

describe("context ownership", () => {
  it("detaches WorkingConversation, draft messages, tool arguments, and schemas", () => {
    const source = messages();
    const working = WorkingConversation.from({
      sessionId: "session-1",
      revision: 1,
      messages: source,
    });
    const registeredTool = tool();
    const preparation = createContextPreparationRequest({
      identity: {
        agentId: "coding",
        sessionId: "session-1",
        sessionRevision: 1,
        modelCallId: "call-1",
      },
      conversation: working.snapshot(),
      systemPrompt: "system",
      tools: [registeredTool],
      model: { modelId: "model", contextWindow: 10, maxOutputTokens: 2 },
      middleware: [],
      progress: { publish() {} },
    });
    const draft = createContextDraft(preparation);

    (toolArguments(preparation.source.messages[1]).path as string) = "context-source";
    (
      preparation.tools[0].schema.properties as Record<string, { metadata: { source: string } }>
    ).path.metadata.source = "context-source";

    (toolArguments(source[1]).path as string) = "changed";
    (
      registeredTool.schema.properties as Record<string, { metadata: { source: string } }>
    ).path.metadata.source = "changed";
    (toolArguments(draft.messages[1]).path as string) = "draft";
    (
      draft.tools[0].schema.properties as Record<string, { metadata: { source: string } }>
    ).path.metadata.source = "draft";

    expect(toolArguments(working.snapshot().messages[1]).path).toBe("README.md");
    expect((toolArguments(working.snapshot().messages[1]).range as { start: number }).start).toBe(
      1,
    );
    expect(
      (registeredTool.schema.properties as Record<string, { metadata: { source: string } }>).path
        .metadata.source,
    ).toBe("changed");
    expect(toolArguments(preparation.source.messages[1]).path).toBe("context-source");
    expect("execute" in preparation.tools[0]).toBe(false);
  });

  it("runs middleware serially and isolates every returned draft", async () => {
    const order: string[] = [];
    let firstOutput: ReturnType<typeof createContextDraft> | undefined;
    const middleware: ContextMiddlewarePort[] = [
      {
        name: "first",
        version: 1,
        transform(draft) {
          order.push("first");
          firstOutput = {
            ...draft,
            messages: [...draft.messages, { role: "user", content: "added", timestamp: 4 }],
            tools: [...draft.tools],
            model: { ...draft.model },
          } as ReturnType<typeof createContextDraft>;
          return firstOutput;
        },
      },
      {
        name: "second",
        version: 2,
        transform(draft) {
          order.push(`second:${draft.messages.length}`);
          return {
            ...draft,
            messages: [...draft.messages],
            tools: [...draft.tools],
            model: { ...draft.model },
          } as ReturnType<typeof createContextDraft>;
        },
      },
    ];
    const input = request(middleware);
    const prepared = await createEngine().prepare(input.preparation);

    (firstOutput!.messages[3] as { content: string }).content = "mutated later";
    expect(order).toEqual(["first", "second:4"]);
    expect(prepared.messages[3]).toMatchObject({ content: "added" });
    expect(prepared.manifest.middleware).toEqual([
      { name: "first", version: 1 },
      { name: "second", version: 2 },
    ]);
    expect(prepared.manifest.sourceMessageCount).toBe(4);
    expect(prepared.manifest.outputMessageCount).toBe(4);
    expect(input.conversation.snapshot().messages).toHaveLength(3);
  });

  it("projects full history without executable tools or transport metadata", async () => {
    const input = request();
    const prepared = await createEngine().prepare(input.preparation);

    expect(prepared.messages).toHaveLength(3);
    expect(prepared.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(prepared.messages.every((message) => !("timestamp" in message))).toBe(true);
    expect(prepared.tools[0]).toEqual({
      name: "inspect",
      description: "Inspect a file",
      schema: input.preparation.tools[0].schema,
      strict: true,
    });
    expect("execute" in prepared.tools[0]).toBe(false);
    expect(prepared.manifest.decisions).toEqual([]);
    expect(prepared.snapshotId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects invalid or aliased middleware and strategy results", async () => {
    const aliased: ContextMiddlewarePort = {
      name: "aliased",
      version: 1,
      transform: (draft) => draft as never,
    };
    const aliasedInput = request([aliased]);
    await expect(createEngine().prepare(aliasedInput.preparation)).rejects.toThrow(
      "must return a new draft",
    );

    const invalidStage: ContextPolicyStagePort = {
      name: "invalid",
      version: 1,
      async apply(frame) {
        return { frame: { ...frame, entries: undefined as never }, decisions: [] };
      },
    };
    const invalidInput = request();
    await expect(
      createEngine([invalidStage]).prepare(invalidInput.preparation),
    ).rejects.toBeInstanceOf(InvalidContextPolicyResultError);
  });

  it("propagates cancellation before invoking a policy stage", async () => {
    const apply = vi.fn<ContextPolicyStagePort["apply"]>();
    const controller = new AbortController();
    controller.abort();
    const input = request();

    await expect(
      createEngine([{ name: "custom", version: 1, apply }]).prepare({
        ...input.preparation,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("creates stable digests for equal calls and a distinct snapshot for a new call id", async () => {
    const engine = createEngine();
    const first = request().preparation;
    const same = request().preparation;
    const next = {
      ...request().preparation,
      identity: { ...first.identity, modelCallId: "model-call-2" },
    };
    const [one, two, three] = await Promise.all([
      engine.prepare(first),
      engine.prepare(same),
      engine.prepare(next),
    ]);

    expect(two.snapshotId).toBe(one.snapshotId);
    expect(three.snapshotId).not.toBe(one.snapshotId);
    expect(two.manifest.sourceDigest).toBe(one.manifest.sourceDigest);
    expect(two.manifest.outputDigest).toBe(one.manifest.outputDigest);
  });
});

function toolArguments(message: TranscriptMessage): Record<string, unknown> {
  if (message.role !== "assistant") throw new Error("Expected assistant message");
  const call = message.content.find((block) => block.type === "toolCall");
  if (!call || call.type !== "toolCall") throw new Error("Expected tool call");
  return call.arguments;
}
