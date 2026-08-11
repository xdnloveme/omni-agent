import { describe, it, expect } from "vitest";
import { bashTool } from "../shell/bash";
import { invokeToolImplementation } from "./tool-test-helper";

describe("bashTool", () => {
  it("should execute a simple echo command", async () => {
    const result = await invokeToolImplementation(bashTool, { command: "echo hello" });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("hello");
  });

  it("should capture stderr output", async () => {
    const result = await invokeToolImplementation(bashTool, { command: "echo err >&2" });

    // stderr is present but exit code is 0, so isError should be false
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("STDERR:");
    expect(result.content[0].text).toContain("err");
  });

  it("should report non-zero exit code as error", async () => {
    const result = await invokeToolImplementation(bashTool, { command: "exit 42" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Exit code: 42");
  });

  it("should handle abort signal", async () => {
    const controller = new AbortController();

    // Start a long-running command, then abort immediately
    const promise = invokeToolImplementation(
      bashTool,
      { command: "sleep 60" },
      { cwd: process.cwd(), signal: controller.signal },
    );
    // Give the process a moment to start
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("should return error when command is empty", async () => {
    const result = await invokeToolImplementation(bashTool, { command: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("command is required");
  });

  it("should return error when command param is missing", async () => {
    const result = await invokeToolImplementation(bashTool, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("command is required");
  });

  it("should truncate very long output", async () => {
    // Generate output longer than MAX_OUTPUT_BYTES (10240)
    const result = await invokeToolImplementation(bashTool, {
      command: "python3 -c \"print('x' * 20000)\"",
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("truncated");
  });
});
