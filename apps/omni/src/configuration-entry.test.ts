import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function run(root: string, name: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        new URL("./configuration-entry.ts", import.meta.url).pathname,
        "--cwd",
        join(root, "project"),
        "--global-directory",
        join(root, "global"),
        "--output-dir",
        join(root, name),
        "--credential-env",
        "OMNI_CONFIGURATION_TEST_KEY",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
it("validates the actual isolated configuration without model calls and retains native missing-model/authentication errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "configuration-entry-"));
  roots.push(root);
  const project = join(root, "project"),
    global = join(root, "global");
  await mkdir(project);
  await mkdir(global);
  const missing = await run(root, "missing");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("Model is not configured for agent: coding");
  await writeFile(
    join(project, "omni.config.json"),
    JSON.stringify({ model: { vendorId: "fixture", connectionId: "default", modelId: "fixture" } }),
  );
  const providers = JSON.parse(
    await readFile(
      new URL("../../../benchmark/adapters/omni/fixtures/omni.providers.json", import.meta.url),
      "utf8",
    ),
  );
  providers.vendors[0].connections[0].envVars = ["OMNI_CONFIGURATION_TEST_KEY"];
  await writeFile(join(project, "omni.providers.json"), JSON.stringify(providers));
  const unauthenticated = await run(root, "unauthenticated");
  expect(unauthenticated.code).toBe(1);
  expect(unauthenticated.stderr).toContain("Provider is not configured: fixture");
  await writeFile(
    join(project, ".env"),
    "OMNI_CONFIGURATION_TEST_KEY=fixture-only-secret\nUNRELATED_KEY=private\n",
  );
  const authenticated = await run(root, "authenticated");
  expect(authenticated.code, authenticated.stderr).toBe(0);
  expect(JSON.parse(authenticated.stdout)).toEqual({
    authEnvironment: { OMNI_CONFIGURATION_TEST_KEY: "fixture-only-secret" },
  });
  expect(authenticated.stderr).not.toContain("fixture-only-secret");
  expect(await readFile(join(root, "authenticated/snapshot.json"), "utf8")).not.toContain(
    "fixture-only-secret",
  );
});
