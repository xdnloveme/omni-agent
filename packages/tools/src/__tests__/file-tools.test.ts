import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileReadTool } from "../filesystem/file-read";
import { fileEditTool } from "../filesystem/file-edit";
import { fileWriteTool } from "../filesystem/file-write";
import { fileMutex } from "../filesystem/file-mutex";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-file-tools-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── file_read ───────────────────────────────────────────────────────────────

describe("fileReadTool", () => {
  it("should read a file with line numbers", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\n", "utf-8");

    const result = await fileReadTool.execute({ file_path: filePath });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("1|line1");
    expect(result.content[0].text).toContain("2|line2");
    expect(result.content[0].text).toContain("3|line3");
  });

  it("should respect offset and limit", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne\n", "utf-8");

    const result = await fileReadTool.execute({
      file_path: filePath,
      offset: 2,
      limit: 2,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("2|b");
    expect(text).toContain("3|c");
    expect(text).not.toContain("1|a");
    expect(text).not.toContain("4|d");
  });

  it("should return error for non-existent file", async () => {
    const result = await fileReadTool.execute({
      file_path: path.join(tmpDir, "nope.txt"),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error");
  });

  it("should return error when file_path is missing", async () => {
    const result = await fileReadTool.execute({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("file_path is required");
  });
});

// ─── file_edit ───────────────────────────────────────────────────────────────

describe("fileEditTool", () => {
  it("should replace a unique string", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    await fs.writeFile(filePath, "hello world\nfoo bar\n", "utf-8");

    const result = await fileEditTool.execute({
      file_path: filePath,
      old_string: "foo bar",
      new_string: "baz qux",
    });

    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("hello world\nbaz qux\n");
  });

  it("should error when old_string is not found", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    await fs.writeFile(filePath, "hello world\n", "utf-8");

    const result = await fileEditTool.execute({
      file_path: filePath,
      old_string: "not here",
      new_string: "replacement",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("should error when old_string appears multiple times", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    await fs.writeFile(filePath, "aaa\naaa\n", "utf-8");

    const result = await fileEditTool.execute({
      file_path: filePath,
      old_string: "aaa",
      new_string: "bbb",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not unique");
  });

  it("should error when file does not exist", async () => {
    const result = await fileEditTool.execute({
      file_path: path.join(tmpDir, "nope.txt"),
      old_string: "x",
      new_string: "y",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error");
  });
});

// ─── file_write ──────────────────────────────────────────────────────────────

describe("fileWriteTool", () => {
  it("should create a file with content", async () => {
    const filePath = path.join(tmpDir, "write.txt");

    const result = await fileWriteTool.execute({
      file_path: filePath,
      content: "hello\nworld\n",
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("Successfully wrote");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("hello\nworld\n");
  });

  it("should create parent directories", async () => {
    const filePath = path.join(tmpDir, "a", "b", "c", "deep.txt");

    const result = await fileWriteTool.execute({
      file_path: filePath,
      content: "deep content",
    });

    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("deep content");
  });

  it("should overwrite existing file", async () => {
    const filePath = path.join(tmpDir, "overwrite.txt");
    await fs.writeFile(filePath, "old content", "utf-8");

    const result = await fileWriteTool.execute({
      file_path: filePath,
      content: "new content",
    });

    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("new content");
  });

  it("should error when file_path is missing", async () => {
    const result = await fileWriteTool.execute({ content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("file_path is required");
  });
});

// ─── FileMutex ───────────────────────────────────────────────────────────────

describe("FileMutex", () => {
  it("should serialize operations on the same file", async () => {
    const filePath = path.join(tmpDir, "mutex.txt");
    await fs.writeFile(filePath, "", "utf-8");

    const order: number[] = [];

    const op = (id: number, delayMs: number) =>
      fileMutex.withLock(filePath, async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, delayMs));
      });

    // Start all concurrently — they should execute in order due to mutex
    await Promise.all([op(1, 30), op(2, 10), op(3, 10)]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("should allow parallel operations on different files", async () => {
    const fileA = path.join(tmpDir, "a.txt");
    const fileB = path.join(tmpDir, "b.txt");
    await fs.writeFile(fileA, "", "utf-8");
    await fs.writeFile(fileB, "", "utf-8");

    const events: string[] = [];

    const opA = fileMutex.withLock(fileA, async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      events.push("a-end");
    });

    const opB = fileMutex.withLock(fileB, async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 50));
      events.push("b-end");
    });

    await Promise.all([opA, opB]);

    // Both should start before either ends (parallel)
    const aStart = events.indexOf("a-start");
    const bStart = events.indexOf("b-start");
    const aEnd = events.indexOf("a-end");
    const bEnd = events.indexOf("b-end");

    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(bEnd);
    // Both start before either ends → parallel
    expect(Math.max(aStart, bStart)).toBeLessThan(Math.min(aEnd, bEnd));
  });
});
