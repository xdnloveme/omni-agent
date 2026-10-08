import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureModelConfiguration } from "../models/configuration-snapshot";
import { ConfigService } from "../config/config-service";
import { ProviderRepository } from "@omni-agent/models";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const model = (id: string) => ({ vendorId: "fixture", connectionId: "default", modelId: id });
it("preserves global Agent overrides, project Provider merging, and selected .env credentials across relocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "configuration-snapshot-"));
  roots.push(root);
  const project = join(root, "project"),
    global = join(root, "global"),
    output = join(root, "snapshot");
  await mkdir(project);
  await mkdir(global);
  await writeFile(
    join(global, "config.json"),
    JSON.stringify({
      model: model("global"),
      agents: { coding: { model: model("global-agent") } },
      outputRetention: { previewBytes: 8192 },
    }),
  );
  await writeFile(join(project, "omni.config.json"), JSON.stringify({ model: model("project") }));
  const provider = (id: string) => ({
    id,
    displayName: id,
    connections: [
      {
        id: "default",
        displayName: "fixture",
        providerId: id,
        baseUrl: "http://127.0.0.1:18080/v1",
        envVars: ["SNAPSHOT_TEST_KEY"],
        protocol: "openai-completions",
        models: [
          {
            id: "fixture",
            name: "fixture",
            contextWindow: 10000,
            maxTokens: 1000,
            reasoning: false,
          },
        ],
      },
    ],
  });
  await writeFile(
    join(global, "providers.json"),
    JSON.stringify({ version: 1, vendors: [provider("global-provider")] }),
  );
  await writeFile(
    join(project, "omni.providers.json"),
    JSON.stringify({ version: 1, vendors: [provider("project-provider")] }),
  );
  await writeFile(join(global, ".env"), "SNAPSHOT_TEST_KEY=global-secret\n");
  await writeFile(
    join(project, ".env"),
    "SNAPSHOT_TEST_KEY=project-secret\nUNRELATED_KEY=do-not-transfer\n",
  );
  const original = new ConfigService({ cwd: project, globalDirectory: global });
  const captured = await captureModelConfiguration({
    cwd: project,
    globalDirectory: global,
    credentialEnvironment: "SNAPSHOT_TEST_KEY",
    outputDirectory: output,
  });
  expect(captured.authEnvironment).toEqual({ SNAPSHOT_TEST_KEY: "project-secret" });
  const frozen = new ConfigService({ cwd: output, globalDirectory: output });
  expect(await frozen.resolveModelConfiguration("coding")).toEqual(
    await original.resolveModelConfiguration("coding"),
  );
  expect((await frozen.resolveModel("coding"))?.modelId).toBe("global-agent");
  expect(await frozen.resolveOutputLimits()).toEqual(await original.resolveOutputLimits());
  expect(await new ProviderRepository({ cwd: output, globalDirectory: output }).list()).toEqual(
    await new ProviderRepository({ cwd: project, globalDirectory: global }).list(),
  );
  await writeFile(join(project, "omni.config.json"), "changed after capture");
  expect((await frozen.resolveModel("coding"))?.modelId).toBe("global-agent");
  for (const name of await readdir(output)) {
    const text = await readFile(join(output, name), "utf8");
    expect(text).not.toContain("project-secret");
    expect(text).not.toContain("do-not-transfer");
  }
});
it("preserves absence without inventing a model or requiring project configuration files", async () => {
  const root = await mkdtemp(join(tmpdir(), "configuration-empty-"));
  roots.push(root);
  const project = join(root, "project"),
    global = join(root, "global"),
    output = join(root, "snapshot");
  await mkdir(project);
  await mkdir(global);
  const captured = await captureModelConfiguration({
    cwd: project,
    globalDirectory: global,
    credentialEnvironment: "SNAPSHOT_MISSING_KEY",
    outputDirectory: output,
  });
  expect(captured.authEnvironment).toEqual({});
  expect(
    await new ConfigService({ cwd: output, globalDirectory: output }).resolveModel("coding"),
  ).toBeNull();
});

it.each([
  ["project", "model"],
  ["global", "model"],
  ["project", "mcp"],
  ["global", "mcp"],
  ["project", "malformed"],
  ["global", "malformed"],
] as const)("rejects unsafe %s %s input before publishing any snapshot", async (scope, kind) => {
  const root = await mkdtemp(join(tmpdir(), "configuration-unsafe-"));
  roots.push(root);
  const project = join(root, "project"),
    global = join(root, "global"),
    output = join(root, "snapshot");
  await mkdir(project);
  await mkdir(global);
  const secret = "synthetic-export-secret";
  // A project Agent override must not exempt the unused global layer from export checks.
  const valid = { model: model("shared"), agents: { coding: { model: model("selected") } } };
  await writeFile(join(project, "omni.config.json"), JSON.stringify(valid));
  await writeFile(join(global, "config.json"), JSON.stringify(valid));
  const unsafe =
    kind === "malformed"
      ? `{"password":"${secret}"`
      : JSON.stringify({
          ...valid,
          ...(kind === "model"
            ? { settings: { apiKey: secret } }
            : {
                mcp: {
                  servers: [
                    {
                      id: "private",
                      transport: "streamable_http",
                      url: "https://example.invalid/mcp",
                      headers: { Authorization: secret },
                    },
                  ],
                },
              }),
        });
  await writeFile(
    scope === "project" ? join(project, "omni.config.json") : join(global, "config.json"),
    unsafe,
  );
  let failure: unknown;
  try {
    await captureModelConfiguration({
      cwd: project,
      globalDirectory: global,
      credentialEnvironment: "SNAPSHOT_MISSING_KEY",
      outputDirectory: output,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain(secret);
  expect(await readdir(root)).not.toContain("snapshot");
});
