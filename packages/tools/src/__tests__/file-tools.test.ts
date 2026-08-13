import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileReadTool } from "../filesystem/file-read";
import { fileEditTool } from "../filesystem/file-edit";
import { fileWriteTool } from "../filesystem/file-write";
import { invokeToolImplementation } from "./tool-test-helper";
import { fileMutex } from "../filesystem/file-mutex";
import { writeDirectFile } from "../filesystem/io/direct-file-writer";
import {
  createFileSnapshot,
  snapshotVersion,
  type FileSnapshot,
} from "../filesystem/io/file-snapshot";

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

    const result = await invokeToolImplementation(fileReadTool, { file_path: filePath });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("1|line1");
    expect(result.content[0].text).toContain("2|line2");
    expect(result.content[0].text).toContain("3|line3");
    expect(result.meta?.presentation).toEqual({
      resource: { kind: "file", path: await fs.realpath(filePath) },
    });
  });

  it("should respect offset and limit", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne\n", "utf-8");

    const result = await invokeToolImplementation(fileReadTool, {
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

  it("returns 500 lines by default and exposes matching continuation metadata", async () => {
    const filePath = path.join(tmpDir, "many.txt");
    await fs.writeFile(
      filePath,
      Array.from({ length: 505 }, (_, index) => `line-${index + 1}`).join("\n"),
    );

    const result = await invokeToolImplementation(fileReadTool, { file_path: filePath });
    const pagination = result.meta?.pagination as Record<string, unknown>;

    expect(result.isError).toBe(false);
    expect(pagination).toMatchObject({
      mode: "lines",
      returnedLines: 500,
      hasMore: true,
      nextOffset: 501,
    });
    expect(result.content[0].text).toContain("offset=501, limit=500");
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(64 * 1024);
  });

  it("accepts an explicit 2000-line range while preserving the output budget", async () => {
    const filePath = path.join(tmpDir, "short-lines.txt");
    await fs.writeFile(filePath, Array.from({ length: 2000 }, () => "x").join("\n"));

    const result = await invokeToolImplementation(fileReadTool, {
      file_path: filePath,
      limit: 2000,
    });

    expect(result).toMatchObject({
      isError: false,
      meta: { pagination: { returnedLines: 2000, hasMore: false } },
    });
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(64 * 1024);
    const limitSchema = (fileReadTool.schema.properties as Record<string, Record<string, unknown>>)
      .limit;
    expect(limitSchema).toMatchObject({ minimum: 1, maximum: 2000 });
  });

  it("requires the previous version when continuing a changed file", async () => {
    const filePath = path.join(tmpDir, "versioned.txt");
    await fs.writeFile(filePath, "one\ntwo\nthree");
    const first = await invokeToolImplementation(fileReadTool, {
      file_path: filePath,
      limit: 1,
    });
    const version = (first.meta?.pagination as Record<string, unknown>).fileVersion;
    await fs.appendFile(filePath, "\nfour");

    const next = await invokeToolImplementation(fileReadTool, {
      file_path: filePath,
      offset: 2,
      limit: 1,
      file_version: version,
    });

    expect(next).toMatchObject({ isError: true, meta: { code: "file_changed" } });
  });

  it("does not validate content after the requested page", async () => {
    const filePath = path.join(tmpDir, "page-boundary.bin");
    await fs.writeFile(
      filePath,
      Buffer.concat([Buffer.from("one\ntwo\n"), Buffer.from([0xff]), Buffer.from("later")]),
    );

    const result = await invokeToolImplementation(fileReadTool, {
      file_path: filePath,
      offset: 2,
      limit: 1,
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("2|two");
  });

  it("continues a long UTF-8 line without splitting a character", async () => {
    const filePath = path.join(tmpDir, "long-line.txt");
    const original = "界".repeat(30_000);
    await fs.writeFile(filePath, original);
    const chunks: string[] = [];
    let input: Record<string, unknown> = { file_path: filePath, limit: 1 };

    for (;;) {
      const result = await invokeToolImplementation(fileReadTool, input);
      expect(result.isError).toBe(false);
      const pagination = result.meta?.pagination as Record<string, unknown>;
      const body = result.content[0].text.split("\n[Partial line]")[0].split("\n[More content")[0];
      chunks.push(body.slice(body.indexOf("|") + 1));
      if (pagination.mode !== "line_chunk") break;
      input = {
        file_path: filePath,
        offset: pagination.lineNumber,
        line_byte_offset: pagination.nextLineByteOffset,
        file_version: pagination.fileVersion,
      };
    }

    expect(chunks.join("")).toBe(original);
  });

  it("rejects invalid long-line continuation before reading", async () => {
    const result = await invokeToolImplementation(fileReadTool, {
      file_path: path.join(tmpDir, "irrelevant.txt"),
      line_byte_offset: 10,
    });
    expect(result).toMatchObject({ isError: true, meta: { code: "invalid_pagination" } });
  });

  it("should return error for non-existent file", async () => {
    const result = await invokeToolImplementation(fileReadTool, {
      file_path: path.join(tmpDir, "nope.txt"),
    });

    expect(result).toMatchObject({ isError: true, meta: { code: "read_failed" } });
  });

  it("should return error when file_path is missing", async () => {
    const result = await invokeToolImplementation(fileReadTool, {});

    expect(result).toMatchObject({ isError: true, meta: { code: "read_failed" } });
  });
});

// ─── file_edit ───────────────────────────────────────────────────────────────

describe("fileEditTool", () => {
  it("should replace a unique string", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    await fs.writeFile(filePath, "hello world\nfoo bar\n", "utf-8");

    const result = await invokeToolImplementation(fileEditTool, {
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

    const result = await invokeToolImplementation(fileEditTool, {
      file_path: filePath,
      old_string: "not here",
      new_string: "replacement",
    });

    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe("match_not_found");
  });

  it("should error when old_string appears multiple times", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    await fs.writeFile(filePath, "aaa\naaa\n", "utf-8");

    const result = await invokeToolImplementation(fileEditTool, {
      file_path: filePath,
      old_string: "aaa",
      new_string: "bbb",
    });

    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe("match_not_unique");
  });

  it("preserves BOM, CRLF, and the final newline", async () => {
    const filePath = path.join(tmpDir, "encoded.txt");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await fs.writeFile(filePath, Buffer.concat([bom, Buffer.from("one\r\ntwo\r\n")]));

    const result = await invokeToolImplementation(fileEditTool, {
      file_path: filePath,
      old_string: "two",
      new_string: "three",
    });

    expect(result.isError).toBe(false);
    expect(await fs.readFile(filePath)).toEqual(
      Buffer.concat([bom, Buffer.from("one\r\nthree\r\n")]),
    );
  });

  it("does not write when the replacement is a no-op", async () => {
    const filePath = path.join(tmpDir, "no-op.txt");
    await fs.writeFile(filePath, "same");
    const result = await invokeToolImplementation(fileEditTool, {
      file_path: filePath,
      old_string: "same",
      new_string: "same",
    });
    expect(result).toMatchObject({ isError: true, meta: { code: "no_change" } });
    expect(await fs.readFile(filePath, "utf8")).toBe("same");
  });

  it("rejects replacement text over the UTF-8 byte limit before writing", async () => {
    const filePath = path.join(tmpDir, "byte-limit.txt");
    await fs.writeFile(filePath, "small");
    const result = await invokeToolImplementation(fileEditTool, {
      file_path: filePath,
      old_string: "界".repeat(400_000),
      new_string: "replacement",
    });

    expect(result).toMatchObject({ isError: true, meta: { code: "file_too_large" } });
    expect(await fs.readFile(filePath, "utf8")).toBe("small");
  });

  it("rejects NUL in generated content before writing", async () => {
    const filePath = path.join(tmpDir, "nul.txt");
    await fs.writeFile(filePath, "before");
    const result = await invokeToolImplementation(fileEditTool, {
      file_path: filePath,
      old_string: "before",
      new_string: "after\0hidden",
    });

    expect(result).toMatchObject({ isError: true, meta: { code: "unsupported_file" } });
    expect(await fs.readFile(filePath, "utf8")).toBe("before");
  });

  it("should error when file does not exist", async () => {
    const result = await invokeToolImplementation(fileEditTool, {
      file_path: path.join(tmpDir, "nope.txt"),
      old_string: "x",
      new_string: "y",
    });

    expect(result).toMatchObject({ isError: true, meta: { code: "read_failed" } });
  });
});

// ─── file_write ──────────────────────────────────────────────────────────────

describe("fileWriteTool", () => {
  it("should create a file with content", async () => {
    const filePath = path.join(tmpDir, "write.txt");

    const result = await invokeToolImplementation(fileWriteTool, {
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

    const result = await invokeToolImplementation(fileWriteTool, {
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

    const result = await invokeToolImplementation(fileWriteTool, {
      file_path: filePath,
      content: "new content",
    });

    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("new content");
  });

  it("should error when file_path is missing", async () => {
    const result = await invokeToolImplementation(fileWriteTool, { content: "x" });

    expect(result).toMatchObject({
      isError: true,
      meta: { code: "write_failed", targetState: "unknown" },
    });
  });

  it("does not create temporary files", async () => {
    const filePath = path.join(tmpDir, "direct.txt");
    await invokeToolImplementation(fileWriteTool, { file_path: filePath, content: "complete" });
    expect(await fs.readdir(tmpDir)).toEqual(["direct.txt"]);
  });

  it("validates content before creating parent directories", async () => {
    const parent = path.join(tmpDir, "invalid-parent");
    const result = await invokeToolImplementation(fileWriteTool, {
      file_path: path.join(parent, "file.txt"),
      content: "界".repeat(2_800_000),
    });

    expect(result).toMatchObject({ isError: true, meta: { code: "file_too_large" } });
    await expect(fs.stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("DirectFileWriter", () => {
  it("does not start a write when already aborted", async () => {
    const filePath = path.join(tmpDir, "aborted.txt");
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeDirectFile({
        path: filePath,
        content: Buffer.from("new"),
        expected: "missing",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("submits one complete buffer when overwriting an existing file", async () => {
    const filePath = path.join(tmpDir, "direct-existing.txt");
    await fs.writeFile(filePath, "old");
    const expected = createFileSnapshot(await fs.stat(filePath, { bigint: true }));
    const writeFile = vi.spyOn(fs, "writeFile");
    try {
      await writeDirectFile({ path: filePath, content: Buffer.from("complete"), expected });
      expect(writeFile).toHaveBeenCalledOnce();
      expect(writeFile).toHaveBeenCalledWith(filePath, Buffer.from("complete"));
    } finally {
      writeFile.mockRestore();
    }
  });

  it("uses exclusive creation for a new file", async () => {
    const filePath = path.join(tmpDir, "direct-new.txt");
    const writeFile = vi.spyOn(fs, "writeFile");
    try {
      await writeDirectFile({
        path: filePath,
        content: Buffer.from("complete"),
        expected: "missing",
      });
      expect(writeFile).toHaveBeenCalledWith(filePath, Buffer.from("complete"), { flag: "wx" });
    } finally {
      writeFile.mockRestore();
    }
  });

  it("reports an unknown target state after a write failure", async () => {
    const filePath = path.join(tmpDir, "direct-failure.txt");
    await fs.writeFile(filePath, "old");
    const expected = createFileSnapshot(await fs.stat(filePath, { bigint: true }));
    const writeFile = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk failure"));
    try {
      await expect(
        writeDirectFile({ path: filePath, content: Buffer.from("complete"), expected }),
      ).rejects.toMatchObject({
        code: "write_failed",
        details: { targetState: "unknown" },
      });
    } finally {
      writeFile.mockRestore();
    }
  });

  it("does not overwrite a file whose snapshot changed", async () => {
    const filePath = path.join(tmpDir, "direct-changed.txt");
    await fs.writeFile(filePath, "old");
    const expected = createFileSnapshot(await fs.stat(filePath, { bigint: true }));
    await fs.writeFile(filePath, "external-change");

    await expect(
      writeDirectFile({ path: filePath, content: Buffer.from("replacement"), expected }),
    ).rejects.toMatchObject({ code: "file_changed" });
    expect(await fs.readFile(filePath, "utf8")).toBe("external-change");
  });
});

describe("FileSnapshot version", () => {
  it("is stable and changes for every version input field", () => {
    const snapshot: FileSnapshot = {
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
      ctimeNs: 5n,
      mode: 0o100644,
    };
    const version = snapshotVersion(snapshot);

    expect(snapshotVersion({ ...snapshot })).toBe(version);
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) {
      expect(snapshotVersion({ ...snapshot, [field]: snapshot[field] + 1n })).not.toBe(version);
    }
  });
});

// ─── FileMutex ───────────────────────────────────────────────────────────────

describe("FileMutex", () => {
  it("should serialize operations on the same file", async () => {
    const filePath = path.join(tmpDir, "mutex.txt");
    await fs.writeFile(filePath, "", "utf-8");

    const order: number[] = [];

    const op = (id: number, delayMs: number) =>
      fileMutex.withLock(filePath, undefined, async () => {
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

    const opA = fileMutex.withLock(fileA, undefined, async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      events.push("a-end");
    });

    const opB = fileMutex.withLock(fileB, undefined, async () => {
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

  it("serializes hard-link aliases by inode", async () => {
    const fileA = path.join(tmpDir, "original.txt");
    const fileB = path.join(tmpDir, "alias.txt");
    await fs.writeFile(fileA, "value");
    await fs.link(fileA, fileB);
    const order: string[] = [];

    let releaseFirst!: () => void;
    const first = fileMutex.withLock(fileA, undefined, async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push("first-end");
    });
    while (!releaseFirst) await new Promise(setImmediate);
    const second = fileMutex.withLock(fileB, undefined, async () => order.push("second"));
    await new Promise(setImmediate);
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("keeps the same path locked while a missing file becomes an inode", async () => {
    const filePath = path.join(tmpDir, "created-under-lock.txt");
    let releaseFirst!: () => void;
    let secondEntered = false;
    const first = fileMutex.withLock(filePath, undefined, async () => {
      await fs.writeFile(filePath, "created");
      await new Promise<void>((resolve) => (releaseFirst = resolve));
    });
    while (!releaseFirst) await new Promise(setImmediate);
    const second = fileMutex.withLock(filePath, undefined, async () => {
      secondEntered = true;
    });
    await new Promise(setImmediate);

    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  it("removes an aborted waiter without blocking the next operation", async () => {
    const filePath = path.join(tmpDir, "cancelled-waiter.txt");
    await fs.writeFile(filePath, "value");
    let releaseFirst!: () => void;
    const first = fileMutex.withLock(
      filePath,
      undefined,
      async () => await new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    while (!releaseFirst) await new Promise(setImmediate);
    const controller = new AbortController();
    const cancelled = fileMutex.withLock(filePath, controller.signal, async () => undefined);
    const final = fileMutex.withLock(filePath, undefined, async () => "finished");

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst();

    await expect(first).resolves.toBeUndefined();
    await expect(final).resolves.toBe("finished");
  });

  it("does not release an inode lock when a hard-link waiter is cancelled", async () => {
    const fileA = path.join(tmpDir, "held-inode.txt");
    const fileB = path.join(tmpDir, "cancelled-alias.txt");
    const fileC = path.join(tmpDir, "final-alias.txt");
    await fs.writeFile(fileA, "value");
    await fs.link(fileA, fileB);
    await fs.link(fileA, fileC);
    let releaseFirst!: () => void;
    let finalEntered = false;
    const first = fileMutex.withLock(
      fileA,
      undefined,
      async () => await new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    while (!releaseFirst) await new Promise(setImmediate);
    const controller = new AbortController();
    const cancelled = fileMutex.withLock(fileB, controller.signal, async () => undefined);
    await new Promise(setImmediate);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const final = fileMutex.withLock(fileC, undefined, async () => {
      finalEntered = true;
    });
    await new Promise(setImmediate);

    expect(finalEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, final]);
    expect(finalEntered).toBe(true);
  });
});
