import { describe, expect, it } from "vitest";
import type { ToolCallContent } from "../messages";
import { createLoopProtection } from "../loop-protection";
import { buildToolResultSignature, stableStringify } from "../loop-protection/signatures";
import { RuntimePromptComposer, type RuntimePromptSection } from "../system-prompt";
import type { ToolResult } from "../types";

const result = (text: string, isError = false, meta?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  isError,
  ...(meta ? { meta } : {}),
});

const call = (
  id: string,
  name = "file_read",
  args: Record<string, unknown> = { path: "src/a.ts" },
): ToolCallContent => ({ type: "toolCall", id, name, arguments: args });

function completeBatch(
  protection: ReturnType<typeof createLoopProtection>,
  entries: Array<{ call: ToolCallContent; result: ToolResult; identity?: string }>,
) {
  protection.beginToolBatch(entries.map((entry) => entry.call));
  for (const entry of entries) {
    protection.observeToolResult({
      call: entry.call,
      result: entry.result,
      toolIdentity: entry.identity ?? `test:${entry.call.name}`,
    });
  }
  return protection.completeToolBatch();
}

describe("loop protection signatures", () => {
  it("canonicalizes object keys recursively while preserving array order", () => {
    expect(stableStringify({ nested: { b: 2, a: 1 }, values: [2, 1] })).toBe(
      stableStringify({ values: [2, 1], nested: { a: 1, b: 2 } }),
    );
    expect(stableStringify({ values: [2, 1] })).not.toBe(stableStringify({ values: [1, 2] }));
  });

  it("uses identity, arguments, error state, and content but ignores result metadata", () => {
    const first = buildToolResultSignature(
      call("one", "file_read", { path: "a", offset: 1 }),
      "origin:file_read",
      result("content", false, { duration: 1 }),
    );
    const reordered = buildToolResultSignature(
      call("two", "file_read", { offset: 1, path: "a" }),
      "origin:file_read",
      result("content", false, { duration: 999 }),
    );

    expect(first).toBe(reordered);
    expect(buildToolResultSignature(call("three"), "other:file_read", result("content"))).not.toBe(
      first,
    );
    expect(
      buildToolResultSignature(
        call("four", "file_read", { path: "a", offset: 1 }),
        "origin:file_read",
        result("content", true),
      ),
    ).not.toBe(first);
  });

  it("skips values that cannot be serialized", () => {
    expect(stableStringify({ invalid: 1n })).toBeNull();
  });
});

describe("RuntimePromptComposer", () => {
  const stable: RuntimePromptSection = {
    id: "stable",
    owner: "loop_protection",
    priority: 100,
    lifetime: "run",
    content: "stable policy",
  };
  const dynamic: RuntimePromptSection = {
    id: "dynamic",
    owner: "loop_protection",
    priority: 200,
    lifetime: "next_model_request",
    content: "dynamic guidance",
  };

  it("composes stable and one-shot sections without mutating the base prompt", () => {
    const composer = new RuntimePromptComposer();
    const base = "base prompt";
    composer.enqueue(dynamic);

    const leased = composer.lease(base, [stable]);
    expect(leased.systemPrompt).toContain("base prompt");
    expect(leased.systemPrompt).toContain("stable policy");
    expect(leased.systemPrompt).toContain("dynamic guidance");
    expect(leased.systemPrompt.indexOf("stable policy")).toBeLessThan(
      leased.systemPrompt.indexOf("dynamic guidance"),
    );
    expect(base).toBe("base prompt");

    composer.markDispatched(leased.id);
    const next = composer.lease(base, [stable]);
    expect(next.systemPrompt).toContain("stable policy");
    expect(next.systemPrompt).not.toContain("dynamic guidance");
  });

  it("keeps a dynamic section until its lease is dispatched", () => {
    const composer = new RuntimePromptComposer();
    composer.enqueue(dynamic);
    composer.lease("base", [stable]);

    expect(composer.lease("base", [stable]).systemPrompt).toContain("dynamic guidance");
  });
});

describe("LoopProtection", () => {
  it("injects soft then strong one-shot guidance and halts on the fourth exact result", () => {
    const protection = createLoopProtection();
    for (let occurrence = 1; occurrence <= 3; occurrence++) {
      const decision = completeBatch(protection, [
        { call: call(`call-${occurrence}`), result: result("same") },
      ]);
      expect(decision.type).toBe(occurrence === 1 ? "continue" : "warn");
      if (occurrence > 1) {
        const lease = protection.leaseSystemPrompt("base", true);
        expect(lease.systemPrompt).toContain("runtime-guidance");
        expect(lease.systemPrompt).not.toContain("src/a.ts");
        protection.markPromptDispatched(lease.id);
      }
    }

    const halted = completeBatch(protection, [{ call: call("call-4"), result: result("same") }]);
    expect(halted).toMatchObject({
      type: "halt",
      diagnostic: { kind: "repeated_result", count: 4, toolNames: ["file_read"] },
    });
  });

  it("warns after three consecutive matching errors even when arguments change", () => {
    const protection = createLoopProtection();
    for (let occurrence = 1; occurrence <= 3; occurrence++) {
      const decision = completeBatch(protection, [
        {
          call: call(`error-${occurrence}`, "bash", { command: `attempt-${occurrence}` }),
          result: result("permission denied", true),
        },
      ]);
      expect(decision.type).toBe(occurrence === 3 ? "warn" : "continue");
    }
    expect(protection.leaseSystemPrompt("base", true).systemPrompt).toContain(
      "failed repeatedly with the same error",
    );
  });

  it("prefers error-specific guidance for an identical failing call", () => {
    const protection = createLoopProtection();
    for (let occurrence = 1; occurrence <= 3; occurrence++) {
      completeBatch(protection, [
        {
          call: call(`error-${occurrence}`, "bash", { command: "same-command" }),
          result: result("permission denied", true),
        },
      ]);
    }

    const prompt = protection.leaseSystemPrompt("base", true).systemPrompt;
    expect(prompt).toContain("failed repeatedly with the same error");
    expect(prompt).not.toContain("Repeated identical tool actions are not making progress");
  });

  it("detects repeated multi-tool batches independently of call order", () => {
    const protection = createLoopProtection();
    let lastDecision;
    for (let occurrence = 1; occurrence <= 4; occurrence++) {
      const entries = [
        { call: call(`read-${occurrence}`), result: result("read") },
        {
          call: call(`grep-${occurrence}`, "grep", { pattern: "x" }),
          result: result("grep"),
        },
      ];
      lastDecision = completeBatch(protection, occurrence % 2 === 0 ? entries.reverse() : entries);
    }
    expect(lastDecision).toMatchObject({
      type: "halt",
      diagnostic: { kind: "repeated_batch", count: 4, period: 1 },
    });
  });

  it("detects four complete alternating batch cycles", () => {
    const protection = createLoopProtection();
    const decisions = [];
    for (let index = 0; index < 8; index++) {
      const isA = index % 2 === 0;
      const decision = completeBatch(protection, [
        {
          call: call(`call-${index}`, isA ? "file_read" : "grep", {
            value: isA ? "A" : "B",
          }),
          result: result(isA ? "A" : "B"),
        },
      ]);
      decisions.push(decision);
      if (decision.type === "warn") {
        const lease = protection.leaseSystemPrompt("base", true);
        protection.markPromptDispatched(lease.id);
      }
    }

    expect(decisions.map((decision) => decision.type)).toEqual([
      "continue",
      "continue",
      "warn",
      "warn",
      "continue",
      "warn",
      "continue",
      "halt",
    ]);
    expect(decisions.at(-1)).toMatchObject({
      type: "halt",
      diagnostic: { kind: "alternating_batch", count: 4, period: 2 },
    });
  });

  it("restores repeated-result enforcement after an alternating cycle breaks", () => {
    const protection = createLoopProtection();
    const sequence = ["A", "B", "A", "B", "A", "Z", "A"];
    const decisions = sequence.map((value, index) =>
      completeBatch(protection, [
        {
          call: call(`call-${index}`, "file_read", { value }),
          result: result(value),
        },
      ]),
    );

    expect(decisions[4]?.type).toBe("continue");
    expect(decisions.at(-1)).toMatchObject({
      type: "halt",
      diagnostic: { kind: "repeated_result", count: 4 },
    });
  });

  it("halts repeated empty tool-use batches instead of spinning forever", () => {
    const protection = createLoopProtection();
    let lastDecision;
    for (let occurrence = 0; occurrence < 4; occurrence++) {
      lastDecision = completeBatch(protection, []);
    }
    expect(lastDecision).toMatchObject({
      type: "halt",
      diagnostic: { kind: "repeated_batch", count: 4, period: 1, toolNames: [] },
    });
  });

  it("adds the stable policy only for tool-enabled runs", () => {
    const protection = createLoopProtection();
    expect(protection.leaseSystemPrompt("base", true).systemPrompt).toContain(
      "# Runtime Tool Loop Policy",
    );
    expect(protection.leaseSystemPrompt("base", false).systemPrompt).toBe("base");
  });
});
