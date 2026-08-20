import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..");
const coreTraceRoot = join(repositoryRoot, "packages", "core", "src", "tracing");
const runtimeObservationRoot = join(
  repositoryRoot,
  "packages",
  "core",
  "src",
  "runtime-observation",
);

describe("tracing architecture", () => {
  it("keeps Core trace contracts independent from storage, hosts, and vendors", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(coreTraceRoot)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (
          /^(?:node:|@omni-agent\/(?:app|cli|agent-))/.test(match[1]) ||
          /(?:opentelemetry|langsmith|langfuse|\/app\/|\/cli\/|\/agents\/)/i.test(match[1])
        ) {
          violations.push(`${relative(repositoryRoot, file)} -> ${match[1]}`);
        }
      }
    }
    expect(violations).toEqual([]);

    const ports = await readFile(join(coreTraceRoot, "ports.ts"), "utf8");
    expect(ports).not.toMatch(/filesystem|location\(|diskUsage|activeRuns|preview|query/i);
  });

  it("keeps Runtime Observation independent from Trace and product layers", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(runtimeObservationRoot)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (
          /^(?:node:|@omni-agent\/)/.test(match[1]) ||
          /(?:tracing|storage|preview|query|vendor|agents)/i.test(match[1])
        ) {
          violations.push(`${relative(repositoryRoot, file)} -> ${match[1]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps Runtime execution files behind the Observation boundary", async () => {
    const runtimeFiles = [
      "packages/core/src/agent-loop.ts",
      "packages/core/src/agent/runner.ts",
      "packages/core/src/tool-calls/tool-call-coordinator.ts",
      "packages/core/src/execution/tool-invocation-runner.ts",
      "packages/app/src/application/agent-application.ts",
      "packages/app/src/application/agent-factory.ts",
    ];
    const forbidden =
      /TracerPort|ReplaySinkPort|SpanPort|startSpan|setStatus|recordError|replay\.record|AgentSpanName|ToolSpanName/;
    const violations: string[] = [];
    for (const path of runtimeFiles) {
      const source = await readFile(join(repositoryRoot, path), "utf8");
      if (forbidden.test(source)) violations.push(path);
    }
    expect(violations).toEqual([]);
  });

  it("keeps Runtime Observation on the Host-only Core entry point", async () => {
    const coreIndex = await readFile(
      join(repositoryRoot, "packages", "core", "src", "index.ts"),
      "utf8",
    );
    expect(coreIndex).not.toMatch(
      /CompositeRuntimeObserver|createRuntimeTraceObservers|runtime-observation/,
    );
    const agentSources = (
      await Promise.all([
        sourceFiles(join(repositoryRoot, "agents")),
        sourceFiles(join(repositoryRoot, "packages", "tools", "src")),
      ])
    ).flat();
    const violations: string[] = [];
    for (const file of agentSources) {
      const source = await readFile(file, "utf8");
      if (/@omni-agent\/core\/host|RuntimeObserverPort|RuntimeRunObservation/.test(source)) {
        violations.push(relative(repositoryRoot, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps concrete Agents independent from Trace infrastructure", async () => {
    const agentSources = await sourceFiles(join(repositoryRoot, "agents"));
    const violations: string[] = [];
    for (const file of agentSources) {
      const source = await readFile(file, "utf8");
      if (/AgentTrace|createTraceCommand|\/tracing(?:\/|["'])/.test(source)) {
        violations.push(relative(repositoryRoot, file));
      }
    }
    expect(violations).toEqual([]);

    const factory = await readFile(
      join(repositoryRoot, "packages/app/src/application/agent-factory.ts"),
      "utf8",
    );
    const blueprintContext = factory.slice(
      factory.indexOf("export interface AgentBlueprintContext"),
      factory.indexOf("export interface AgentModule"),
    );
    expect(blueprintContext).not.toMatch(/trace/i);
  });

  it("keeps AgentApplication behind the Run Observation lifecycle port", async () => {
    const application = await readFile(
      join(repositoryRoot, "packages/app/src/application/agent-application.ts"),
      "utf8",
    );
    expect(application).toContain("AgentRunObservationPort");
    expect(application).not.toMatch(
      /from\s+["'][^"']*tracing|AgentRunTrace|AgentScopedTraceRuntime|TraceRunScope/,
    );
  });

  it("keeps the Preview transport behind the App query boundary", async () => {
    const sources = await Promise.all(
      [
        "packages/cli/src/tracing-preview/preview-server.ts",
        "packages/cli/src/tracing-preview/preview-command.ts",
        "packages/cli/src/tracing-clear/clear-command.ts",
      ].map((path) => readFile(join(repositoryRoot, path), "utf8")),
    );
    expect(sources[0]).toContain("TraceQueryPort");
    expect(sources.join("\n")).not.toMatch(
      /LocalTraceStore|TraceQueryService|TraceStorageLayout|assertSafePath|layout\./,
    );
    const appIndex = await readFile(
      join(repositoryRoot, "packages", "app", "src", "index.ts"),
      "utf8",
    );
    expect(appIndex).not.toMatch(/LocalTraceStore|TraceQueryService|TraceStorageLayout/);
  });

  it("keeps shared trace semantics and sanitization single-sourced", async () => {
    const productionRoots = [
      join(repositoryRoot, "packages", "core", "src"),
      join(repositoryRoot, "packages", "app", "src"),
      join(repositoryRoot, "packages", "cli", "src"),
      join(repositoryRoot, "agents"),
    ];
    const sources = await Promise.all(
      (await Promise.all(productionRoots.map(sourceFiles)))
        .flat()
        .map((file) => readFile(file, "utf8")),
    );
    const combined = sources.join("\n");
    expect(combined.match(/function\s+sanitizeTracePayload\s*\(/g)).toHaveLength(1);
    expect(combined.match(/export const RuntimeSpanName\s*=/g)).toHaveLength(1);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory() && ["dist", "node_modules"].includes(entry.name)) {
        return Promise.resolve([]);
      }
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : []);
    }),
  );
  return nested.flat();
}
