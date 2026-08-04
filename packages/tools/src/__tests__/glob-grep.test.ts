import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { globTool } from "../search/glob";
import { grepTool } from "../search/grep";

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

    const result = await globTool.execute({
      pattern: "*.ts",
      dir_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.js");
  });

  it("should find files recursively with **", async () => {
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "sub", "deep.ts"), "");
    await fs.writeFile(path.join(tmpDir, "top.ts"), "");

    const result = await globTool.execute({
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

    const result = await globTool.execute({
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
      promises.push(
        fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(3, "0")}.txt`), ""),
      );
    }
    await Promise.all(promises);

    const result = await globTool.execute({
      pattern: "*.txt",
      dir_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("showing first 200");
    // Count the file entries (lines after the header)
    const lines = text.split("\n").filter((l) => l.endsWith(".txt"));
    expect(lines.length).toBe(200);
  });

  it("should return message when no files match", async () => {
    const result = await globTool.execute({
      pattern: "*.xyz",
      dir_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("No files matched");
  });

  it("should return error when pattern is missing", async () => {
    const result = await globTool.execute({});

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

    const result = await grepTool.execute({
      regex: "foo",
      search_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("sample.ts");
    expect(text).toContain("1:");
    expect(text).toContain("const foo = 1");
    expect(text).toContain("const foobar = 3");
  });

  it("should support ignore_case", async () => {
    await fs.writeFile(
      path.join(tmpDir, "case.txt"),
      "Hello World\nhello world\nHELLO WORLD\n",
    );

    const result = await grepTool.execute({
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

  it("should filter by glob pattern", async () => {
    await fs.writeFile(path.join(tmpDir, "match.ts"), "target line\n");
    await fs.writeFile(path.join(tmpDir, "skip.js"), "target line\n");

    const result = await grepTool.execute({
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
    const lines = Array.from({ length: 100 }, (_, i) => `match line ${i}`).join(
      "\n",
    );
    await fs.writeFile(path.join(tmpDir, "many.txt"), lines);

    const result = await grepTool.execute({
      regex: "match",
      search_path: tmpDir,
      max_results: 5,
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    const matchingLines = text.split("\n").filter((l) => l.includes("match line"));
    expect(matchingLines.length).toBe(5);
  });

  it("should return no matches message when nothing found", async () => {
    await fs.writeFile(path.join(tmpDir, "empty.txt"), "nothing here\n");

    const result = await grepTool.execute({
      regex: "zzzzz_not_found",
      search_path: tmpDir,
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("No matches found");
  });

  it("should return error when regex is missing", async () => {
    const result = await grepTool.execute({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("regex is required");
  });
});
