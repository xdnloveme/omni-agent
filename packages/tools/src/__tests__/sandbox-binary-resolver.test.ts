import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxBinaryResolver } from "../process/sandbox-binary-resolver";
import { VersionedFileComputationCache } from "../process/versioned-file-computation-cache";
import { SharedOperation } from "../process/shared-operation";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SandboxBinaryResolver", () => {
  it("shares verification and revalidates changed binaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-sandbox-binary-"));
    temporaryDirectories.push(root);
    const binary = path.join(root, "omni-sandbox");
    await writeFile(binary, "v1", { mode: 0o755 });
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let verifications = 0;
    const resolver = new SandboxBinaryResolver([binary], async (_candidate, signal) => {
      verifications += 1;
      if (verifications > 1) return;
      markStarted();
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const first = resolver.resolve();
    await started;
    const second = resolver.resolve();
    release();

    await expect(first).resolves.toBe(binary);
    await expect(second).resolves.toBe(binary);
    await expect(resolver.resolve()).resolves.toBe(binary);
    expect(verifications).toBe(1);

    await writeFile(binary, "v2");
    await expect(resolver.resolve()).resolves.toBe(binary);
    expect(verifications).toBe(2);
  });
});

describe("SharedOperation", () => {
  it("lets one waiter abort without cancelling another waiter", async () => {
    let release!: () => void;
    let operationSignal!: AbortSignal;
    const operation = new SharedOperation(async (signal) => {
      operationSignal = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "ready";
    });
    const controller = new AbortController();
    const cancelled = operation.wait(controller.signal);
    const active = operation.wait();

    controller.abort();
    expect(operationSignal.aborted).toBe(false);
    release();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(active).resolves.toBe("ready");
  });

  it("replaces an abandoned file computation instead of reusing its cancelled flight", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-abandoned-flight-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    await writeFile(source, "stable");
    const cache = new VersionedFileComputationCache<string>();
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const abandoned = cache.get(source, controller.signal, async (signal) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return "abandoned";
    });

    await started;
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await expect(cache.get(source, undefined, async () => "fresh")).resolves.toBe("fresh");
  });
});
