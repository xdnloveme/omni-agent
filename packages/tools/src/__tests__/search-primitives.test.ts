import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFileSizes } from "../search/file-metadata";

describe("search file metadata", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "omni-search-metadata-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("deduplicates paths and degrades unavailable files to null", async () => {
    await fs.writeFile(path.join(directory, "present.txt"), "content");

    const sizes = await loadFileSizes(["present.txt", "missing.txt", "present.txt"], directory);

    expect([...sizes.entries()]).toEqual([
      ["present.txt", 7],
      ["missing.txt", null],
    ]);
  });
});
