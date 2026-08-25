import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Agent Host architecture", () => {
  it("keeps AgentServicePort as the only business boundary", async () => {
    const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
    const productionFiles = (await readdir(sourceDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name);
    const source = (
      await Promise.all(
        productionFiles.map((file) => readFile(join(sourceDirectory, file), "utf8")),
      )
    ).join("\n");

    expect(source).not.toMatch(
      /@omni-agent\/(?:core|models|tools|cli|ui|agent-|app\/)|AgentFactory|AgentPackageCatalog|AgentRunner|AgentSessionRepository|ToolCallCoordinator/,
    );
    expect(source).not.toMatch(/\b(?:coding|financial-analysis)\b/);
    expect(source).not.toMatch(/\b(?:console\.|process\.exit)/);
    expect(source.match(/from "@omni-agent\/app"/g)?.length).toBeGreaterThan(0);

    const allowedAppImports = new Set([
      "AgentServiceAgent",
      "AgentServiceEvent",
      "AgentServiceFailure",
      "AgentServicePort",
      "AgentServiceRunRequest",
      "AgentServiceSession",
      "toAgentServiceFailure",
    ]);
    const importedAppSymbols = [
      ...source.matchAll(/import(?:\s+type)?\s*\{([^}]+)\}\s*from "@omni-agent\/app";/g),
    ]
      .flatMap((match) => match[1]?.split(",") ?? [])
      .map((name) => name.trim().replace(/^type\s+/, ""))
      .filter(Boolean);

    expect(importedAppSymbols).toContain("AgentServicePort");
    expect(importedAppSymbols.filter((name) => !allowedAppImports.has(name))).toEqual([]);
    expect(source).not.toMatch(
      /import\s+(?:\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s+"@omni-agent\/app"/,
    );
  });
});
