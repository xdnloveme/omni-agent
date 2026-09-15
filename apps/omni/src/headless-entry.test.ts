import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function invoke(args: string[]) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", new URL("./headless-entry.ts", import.meta.url).pathname, ...args],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

it("requires explicit unrestricted authorization before creating output or state", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-consent-"));
  directories.push(root);
  const result = await invoke(["--output-dir", join(root, "output")]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("requires --confirm-unrestricted");
  expect(await readdir(root)).toEqual([]);
});

it("rejects an existing state directory without changing its execution settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-isolation-"));
  directories.push(root);
  const output = join(root, "output");
  const state = join(output, "state");
  await mkdir(state, { recursive: true });
  const sentinel = join(state, "execution-settings.json");
  await writeFile(sentinel, "existing state must remain unchanged");
  const input = join(root, "input.txt");
  await writeFile(input, "Do one task");
  const result = await invoke([
    "--confirm-unrestricted",
    "--input-file",
    input,
    "--config-file",
    join(root, "unused-config"),
    "--providers-file",
    join(root, "unused-providers"),
    "--output-dir",
    output,
    "--cwd",
    root,
  ]);
  expect(result.code).toBe(1);
  expect(await readFile(sentinel, "utf8")).toBe("existing state must remain unchanged");
  expect(await readdir(state)).toEqual(["execution-settings.json"]);
  expect(JSON.parse(await readFile(join(output, "result.json"), "utf8"))).toMatchObject({
    status: "failed",
    code: "headless_execution_failed",
    trace: { integrity: "missing" },
  });
});
