import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentExtensions } from "../extensions/agent-extension-loader";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function extensionSource(id: string, version: string): string {
  return `export default { manifest: { id: ${JSON.stringify(id)}, version: ${JSON.stringify(version)}, apiVersion: 1 }, contributions: {} };\n`;
}

describe("loadAgentExtensions", () => {
  it("merges global and project extensions by manifest id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-project-extensions-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-global-extensions-"));
    directories.push(cwd, globalDirectory);
    writeFileSync(
      join(globalDirectory, "extensions.mjs"),
      `export default [
        { manifest: { id: "shared", version: "global", apiVersion: 1 }, contributions: {} },
        { manifest: { id: "global-only", version: "1", apiVersion: 1 }, contributions: {} }
      ];\n`,
    );
    writeFileSync(join(cwd, "omni.extensions.mjs"), extensionSource("shared", "project"));

    const result = await loadAgentExtensions({ cwd, globalDirectory });

    expect(result.diagnostics).toEqual([]);
    expect(result.extensions.map(({ extension }) => extension.manifest)).toEqual([
      expect.objectContaining({ id: "shared", version: "project" }),
      expect.objectContaining({ id: "global-only", version: "1" }),
    ]);
    expect(result.extensions[0]?.source).toBe(join(cwd, "omni.extensions.mjs"));
  });
});
