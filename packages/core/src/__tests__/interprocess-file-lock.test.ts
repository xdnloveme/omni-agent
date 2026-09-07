import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InterprocessFileLock } from "../persistence";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-lock-"));
  directories.push(root);
  return join(root, "resource.lock");
}

async function writeLock(path: string, metadata: object): Promise<void> {
  await mkdir(path);
  await writeFile(join(path, "owner.json"), JSON.stringify(metadata));
}

describe("InterprocessFileLock", () => {
  it("does not remove an old lock owned by a live process", async () => {
    const path = await fixture();
    await writeLock(path, { pid: process.pid, owner: "active", createdAt: Date.now() - 60_000 });
    const lock = new InterprocessFileLock(path, { retryMs: 2, timeoutMs: 20, staleMs: 1 });

    await expect(lock.runExclusive(async () => undefined)).rejects.toThrow(
      "Timed out waiting for file lock",
    );
  });

  it("reclaims an old lock whose owner process is gone", async () => {
    const path = await fixture();
    await writeLock(path, { pid: 2_147_483_647, owner: "stale", createdAt: Date.now() - 60_000 });
    const lock = new InterprocessFileLock(path, { retryMs: 2, timeoutMs: 100, staleMs: 1 });

    await expect(lock.runExclusive(async () => "acquired")).resolves.toBe("acquired");
  });

  it("serializes contenders that race to reclaim the same stale lock", async () => {
    const path = await fixture();
    const first = new InterprocessFileLock(path, { retryMs: 1, timeoutMs: 1_000, staleMs: 1 });
    const second = new InterprocessFileLock(path, { retryMs: 1, timeoutMs: 1_000, staleMs: 1 });
    let active = 0;
    let maximumActive = 0;

    const enter = (lock: InterprocessFileLock) =>
      lock.runExclusive(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      });

    for (let iteration = 0; iteration < 100; iteration += 1) {
      await writeLock(path, { pid: 2_147_483_647, owner: "stale", createdAt: Date.now() - 60_000 });
      await Promise.all([enter(first), enter(second)]);
    }
    expect(maximumActive).toBe(1);
  });

  it("atomically replaces an empty retired lock without exposing uninitialized ownership", async () => {
    const path = await fixture();
    await mkdir(path);
    await new InterprocessFileLock(path).runExclusive(async () => {
      expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toMatchObject({
        pid: process.pid,
      });
    });
  });

  it("does not unlink a lock whose owner changed before release", async () => {
    const path = await fixture();
    const lock = new InterprocessFileLock(path);
    await lock.runExclusive(async () => {
      await writeFile(
        join(path, "owner.json"),
        JSON.stringify({ pid: process.pid, owner: "replacement", createdAt: Date.now() }),
      );
    });

    await expect(readFile(join(path, "owner.json"), "utf8")).resolves.toContain(
      '"owner":"replacement"',
    );
  });
});
