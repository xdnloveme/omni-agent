import { describe, it, expect } from "vitest";
import { bashTool } from "../shell/bash";

describe("bashTool", () => {
  it("should execute a simple echo command", async () => {
    const result = await bashTool.execute({ command: "echo hello" });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("hello");
  });

  it("should capture stderr output", async () => {
    const result = await bashTool.execute({ command: "echo err >&2" });

    // stderr is present but exit code is 0, so isError should be false
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("STDERR:");
    expect(result.content[0].text).toContain("err");
  });

  it("should report non-zero exit code as error", async () => {
    const result = await bashTool.execute({ command: "exit 42" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Exit code: 42");
  });

  it("should handle abort signal", async () => {
    const controller = new AbortController();

    // Start a long-running command, then abort immediately
    const promise = bashTool.execute({ command: "sleep 60" }, controller.signal);
    // Give the process a moment to start
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    const result = await promise;
    // The process should have been killed
    // When aborted, the process is killed and we get some output
    expect(result).toBeDefined();
  });

  it("should return error when command is empty", async () => {
    const result = await bashTool.execute({ command: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("command is required");
  });

  it("should return error when command param is missing", async () => {
    const result = await bashTool.execute({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("command is required");
  });

  it("should truncate very long output", async () => {
    // Generate output longer than MAX_OUTPUT_BYTES (10240)
    const result = await bashTool.execute({
      command: "python3 -c \"print('x' * 20000)\"",
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("truncated");
  });
});
