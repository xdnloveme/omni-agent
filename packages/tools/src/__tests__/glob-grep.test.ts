import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { globTool } from "../search/glob";
import { grepTool } from "../search/grep";
import { fileReadTool } from "../filesystem/file-read";
import { invokeToolImplementation } from "./tool-test-helper";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-glob-grep-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── glob ────────────────────────────────────────────────────────────────────

describe("globTool", () => {
  it("should find files matching a pattern", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), "");
    await fs.writeFile(path.join(tmpDir, "b.ts"), "");
    await fs.writeFile(path.join(tmpDir, "c.js"), "");

    const result = await invokeToolImplementation(globTool, {
      pattern: "*.ts",
      dir_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.js");
    expect(result.meta).toMatchObject({
      totalMatches: 2,
      returnedFiles: 2,
      truncated: false,
      files: [
        { path: "a.ts", sizeBytes: 0 },
        { path: "b.ts", sizeBytes: 0 },
      ],
    });
  });

  it("should find files recursively with **", async () => {
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "sub", "deep.ts"), "");
    await fs.writeFile(path.join(tmpDir, "top.ts"), "");

    const result = await invokeToolImplementation(globTool, {
      pattern: "**/*.ts",
      dir_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("deep.ts");
    expect(text).toContain("top.ts");
  });

  it("should respect exclude patterns", async () => {
    await fs.writeFile(path.join(tmpDir, "keep.ts"), "");
    await fs.writeFile(path.join(tmpDir, "skip.test.ts"), "");

    const result = await invokeToolImplementation(globTool, {
      pattern: "*.ts",
      dir_path: tmpDir,
      exclude: ["*.test.ts"],
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("keep.ts");
    expect(text).not.toContain("skip.test.ts");
  });

  it("should limit results to 200", async () => {
    // Create 210 files
    const promises = [];
    for (let i = 0; i < 210; i++) {
      promises.push(fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(3, "0")}.txt`), ""));
    }
    await Promise.all(promises);

    const result = await invokeToolImplementation(globTool, {
      pattern: "*.txt",
      dir_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("showing first 200");
    expect(result.meta).toMatchObject({
      totalMatches: 210,
      returnedFiles: 200,
      truncated: true,
    });
  });

  it("should return message when no files match", async () => {
    const result = await invokeToolImplementation(globTool, {
      pattern: "*.xyz",
      dir_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("No files matched");
    expect(result.meta).toEqual({
      files: [],
      totalMatches: 0,
      returnedFiles: 0,
      truncated: false,
    });
  });

  it("should return error when pattern is missing", async () => {
    const result = await invokeToolImplementation(globTool, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pattern is required");
  });
});

// ─── grep ────────────────────────────────────────────────────────────────────

describe("grepTool", () => {
  it("should find matching lines with line numbers", async () => {
    await fs.writeFile(
      path.join(tmpDir, "sample.ts"),
      "const foo = 1;\nconst bar = 2;\nconst foobar = 3;\n",
    );

    const result = await invokeToolImplementation(grepTool, {
      regex: "foo",
      search_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("sample.ts");
    expect(text).toContain("1:");
    expect(text).toContain("const foo = 1");
    expect(text).toContain("const foobar = 3");
    expect(result.meta).toMatchObject({
      returnedMatches: 2,
      totalMatches: 2,
      truncated: false,
    });
    const files = result.meta?.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      sizeBytes: 48,
      matches: [
        { line: 1, column: 7, preview: "const foo = 1;" },
        { line: 3, column: 7, preview: "const foobar = 3;" },
      ],
    });
  });

  it("should support ignore_case", async () => {
    await fs.writeFile(path.join(tmpDir, "case.txt"), "Hello World\nhello world\nHELLO WORLD\n");

    const result = await invokeToolImplementation(grepTool, {
      regex: "hello",
      search_path: tmpDir,
      ignore_case: true,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("Hello World");
    expect(text).toContain("hello world");
    expect(text).toContain("HELLO WORLD");
  });

  it("accepts a single file as search_path", async () => {
    const filePath = path.join(tmpDir, "single.txt");
    await fs.writeFile(filePath, "needle\nother\n");

    const result = await invokeToolImplementation(grepTool, {
      regex: "needle",
      search_path: filePath,
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("needle");
  });

  it("should filter by glob pattern", async () => {
    await fs.writeFile(path.join(tmpDir, "match.ts"), "target line\n");
    await fs.writeFile(path.join(tmpDir, "skip.js"), "target line\n");

    const result = await invokeToolImplementation(grepTool, {
      regex: "target",
      search_path: tmpDir,
      glob: "*.ts",
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("match.ts");
    expect(text).not.toContain("skip.js");
  });

  it("should respect max_results", async () => {
    // Create a file with many matching lines
    const lines = Array.from({ length: 100 }, (_, i) => `match line ${i}`).join("\n");
    await fs.writeFile(path.join(tmpDir, "many.txt"), lines);

    const result = await invokeToolImplementation(grepTool, {
      regex: "match",
      search_path: tmpDir,
      max_results: 5,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    const matchingLines = text.split("\n").filter((line: string) => line.includes("match line"));
    expect(matchingLines.length).toBe(5);
    expect(result.meta).toMatchObject({ returnedMatches: 5, totalMatches: 100, truncated: true });
  });

  it("applies max_results globally across files", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "hit\nhit\nhit\n");
    await fs.writeFile(path.join(tmpDir, "b.txt"), "hit\nhit\nhit\n");

    const result = await invokeToolImplementation(grepTool, {
      regex: "hit",
      search_path: tmpDir,
      max_results: 4,
    });

    expect(result).toMatchObject({
      isError: false,
      meta: { returnedMatches: 4, totalMatches: 6, truncated: true },
    });
  });

  it("keeps visible text bounded and reports matches omitted by the text budget", async () => {
    const content = Array.from(
      { length: 200 },
      (_, index) => `target-${index} ${"x".repeat(600)}`,
    ).join("\n");
    await fs.writeFile(path.join(tmpDir, "verbose.txt"), content);

    const result = await invokeToolImplementation(grepTool, {
      regex: "target-",
      search_path: tmpDir,
      max_results: 1000,
    });

    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.meta).toMatchObject({ totalMatches: 200, truncated: true });
    expect(result.meta?.returnedMatches).toBeLessThan(200);
  });

  it("treats a regex beginning with a dash as data", async () => {
    await fs.writeFile(path.join(tmpDir, "dash.txt"), "value -needle here\n");

    const result = await invokeToolImplementation(grepTool, {
      regex: "-needle",
      search_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("value -needle here");
  });

  it("should return no matches message when nothing found", async () => {
    await fs.writeFile(path.join(tmpDir, "empty.txt"), "nothing here\n");

    const result = await invokeToolImplementation(grepTool, {
      regex: "zzzzz_not_found",
      search_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("No matches found");
  });

  it("treats every ripgrep exit code other than zero or one as an error", async () => {
    const result = await invokeToolImplementation(grepTool, {
      regex: "[",
      search_path: tmpDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ripgrep error");
  });

  it("should propagate AbortError and terminate its subprocess", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      invokeToolImplementation(
        grepTool,
        { regex: "content", search_path: tmpDir },
        { cwd: process.cwd(), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("search path access", () => {
  it.each([
    [globTool, { pattern: "*", dir_path: "../outside" }],
    [grepTool, { regex: "secret", search_path: "../outside" }],
  ])("assesses external search roots for %s", async (tool, input) => {
    if (tool.access.kind !== "dynamic") throw new Error("expected dynamic access");
    const intent = await tool.access.assess(input, {
      cwd: tmpDir,
      agentId: "test",
      toolCallId: "call-1",
      workspaceId: "workspace",
      workspaceRoot: tmpDir,
      hostRuntime: { platform: process.platform, home: process.env.HOME ?? tmpDir },
    });
    expect(intent.resources).toContainEqual(
      expect.objectContaining({ kind: "filesystem", location: "external" }),
    );
  });
});

describe("search navigation workflow", () => {
  it("uses glob size and grep location to read a focused file range", async () => {
    const lines = Array.from({ length: 600 }, (_, index) =>
      index === 449 ? "export const targetValue = 42;" : `line ${index + 1}`,
    );
    await fs.writeFile(path.join(tmpDir, "target.ts"), lines.join("\n"));

    const discovered = await invokeToolImplementation(globTool, {
      pattern: "*.ts",
      dir_path: tmpDir,
    });
    const located = await invokeToolImplementation(grepTool, {
      regex: "targetValue",
      search_path: tmpDir,
    });
    const matchFile = (located.meta?.files as Array<Record<string, unknown>>)[0];
    const match = (matchFile.matches as Array<Record<string, number>>)[0];
    const read = await invokeToolImplementation(fileReadTool, {
      file_path: matchFile.path,
      offset: match.line - 2,
      limit: 5,
    });

    expect(discovered.content[0].text).toContain("target.ts (");
    expect(located.content[0].text).toContain("450:14");
    expect(read.content[0].text).toContain("450|export const targetValue = 42;");
  });
});
