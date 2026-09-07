import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => childProcess);
import { GodotExecutableError, resolveGodotExecutable } from "./godot-executable-resolver";

const temporaryDirectories: string[] = [];
const versions = new Map<string, string>();

beforeEach(() => {
  childProcess.execFile.mockImplementation((file, _args, _options, callback) => {
    callback(null, `${versions.get(String(file)) ?? ""}\n`, "");
    return {} as never;
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Godot executable resolver", () => {
  it("uses an explicit 4.7.2 executable without exposing it through a fallback", async () => {
    const directory = await temporaryDirectory();
    const executable = await fakeGodot(directory, "4.7.2.stable.official");

    await expect(
      resolveGodotExecutable({
        cwd: directory,
        platform: "darwin",
        environment: { OMNI_GODOT_BINARY: executable, PATH: "" },
      }),
    ).resolves.toBe(executable);
  }, 10_000);

  it("fails closed when the configured Godot version does not match", async () => {
    const directory = await temporaryDirectory();
    const executable = await fakeGodot(directory, "4.7.1.stable.official");

    await expect(
      resolveGodotExecutable({
        cwd: directory,
        platform: "linux",
        environment: { OMNI_GODOT_BINARY: executable, PATH: "" },
      }),
    ).rejects.toMatchObject({
      code: "godot_version_mismatch",
    } satisfies Partial<GodotExecutableError>);
  }, 10_000);

  it("reports the explicit setup requirement when no executable exists", async () => {
    const directory = await temporaryDirectory();

    await expect(
      resolveGodotExecutable({
        cwd: directory,
        platform: "linux",
        environment: { PATH: "" },
      }),
    ).rejects.toMatchObject({ code: "godot_not_found" } satisfies Partial<GodotExecutableError>);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omni-godot-resolver-"));
  temporaryDirectories.push(path);
  return path;
}

async function fakeGodot(directory: string, version: string): Promise<string> {
  const path = join(directory, "godot");
  await writeFile(path, "test executable", "utf8");
  await chmod(path, 0o755);
  versions.set(path, version);
  return path;
}
