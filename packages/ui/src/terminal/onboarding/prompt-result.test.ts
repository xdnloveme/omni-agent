import { describe, expect, it } from "vitest";
import { normalizePromptResult } from "./prompt-result";

describe("normalizePromptResult", () => {
  it.each(["ExitPromptError", "AbortPromptError"])(
    "normalizes %s into the shared cancellation contract",
    async (name) => {
      const failure = new Error("prompt terminated");
      failure.name = name;

      await expect(normalizePromptResult(Promise.reject(failure))).rejects.toMatchObject({
        name: "AbortError",
      });
    },
  );

  it("preserves non-cancellation prompt failures", async () => {
    const failure = new Error("terminal unavailable");
    await expect(normalizePromptResult(Promise.reject(failure))).rejects.toBe(failure);
  });
});
