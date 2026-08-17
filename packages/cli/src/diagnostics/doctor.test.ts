import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "./doctor";

describe("runDoctor", () => {
  it("reports every check without stopping at the first failure", async () => {
    const write = vi.fn();
    const later = vi.fn(async () => "ready");
    const ok = await runDoctor({
      write,
      checks: [
        { name: "broken", run: async () => Promise.reject(new Error("not ready")) },
        { name: "later", run: later },
      ],
    });

    expect(ok).toBe(false);
    expect(later).toHaveBeenCalledOnce();
    expect(write.mock.calls.flat().join("")).toContain("✗ broken: not ready");
    expect(write.mock.calls.flat().join("")).toContain("✓ later: ready");
  });

  it("rejects a writable file used as the global directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-doctor-"));
    const globalDirectory = join(root, "not-a-directory");
    await writeFile(globalDirectory, "file");
    const output: string[] = [];
    try {
      expect(
        await runDoctor({ cwd: root, globalDirectory, write: (text) => output.push(text) }),
      ).toBe(false);
      expect(output.join("")).toContain(
        `✗ Global directory: Expected a directory: ${globalDirectory}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
