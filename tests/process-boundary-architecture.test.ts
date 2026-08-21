import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cliRoot = join(import.meta.dirname, "..", "packages", "cli", "src");
const appRoot = join(import.meta.dirname, "..", "packages", "app", "src");

describe("CLI process boundary", () => {
  it("keeps process and console side effects in apps/omni", async () => {
    const sources = await Promise.all(
      (await files(cliRoot))
        .filter((path) => !path.endsWith(".test.ts"))
        .map((path) => readFile(path, "utf8")),
    );
    const combined = sources.join("\n");
    expect(combined).not.toMatch(/\bprocess\./);
    expect(combined).not.toMatch(/\bconsole\.(?:log|warn|error|info)/);
    expect(combined).not.toMatch(/from\s+["']node:process["']/);
  });

  it("keeps process-derived paths out of App services", async () => {
    const sources = await Promise.all(
      (await files(appRoot))
        .filter((path) => !path.endsWith(".test.ts") && !path.includes("/__tests__/"))
        .map((path) => readFile(path, "utf8")),
    );
    const combined = sources.join("\n");

    expect(combined).not.toMatch(/\bprocess\.cwd\(\)/);
  });
});

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory()
          ? files(path)
          : Promise.resolve(path.endsWith(".ts") ? [path] : []);
      }),
    )
  ).flat();
}
