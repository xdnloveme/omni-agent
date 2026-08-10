import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { passwords, keytar } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    passwords: values,
    keytar: {
      getPassword: vi.fn(async (_service: string, account: string) => values.get(account) ?? null),
      setPassword: vi.fn(async (_service: string, account: string, value: string) => {
        values.set(account, value);
      }),
      deletePassword: vi.fn(async (_service: string, account: string) => values.delete(account)),
      findCredentials: vi.fn(async () => []),
    },
  };
});

vi.mock("keytar", () => ({ default: keytar }));

import { KeytarCredentialStore } from "../credentials/keytar-store";

const dirs: string[] = [];
beforeEach(() => {
  passwords.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("KeytarCredentialStore", () => {
  it("reads migrated accounts and writes the canonical credential shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-store-"));
    dirs.push(dir);
    passwords.set("kimi", "legacy-key");
    const store = new KeytarCredentialStore(join(dir, "index.json"));
    await expect(store.read("moonshotai")).resolves.toEqual({ type: "api_key", key: "legacy-key" });
    await store.modify("moonshotai", async () => ({ type: "api_key", key: "new-key" }));
    expect(JSON.parse(passwords.get("credential:moonshotai")!)).toEqual({
      type: "api_key",
      key: "new-key",
    });
  });

  it("lists only the non-secret index without enumerating keychain passwords", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-index-"));
    dirs.push(dir);
    const store = new KeytarCredentialStore(join(dir, "index.json"));
    await store.modify("openai", async () => ({ type: "api_key", key: "secret" }));
    await expect(store.list()).resolves.toEqual([{ providerId: "openai", type: "api_key" }]);
    expect(keytar.findCredentials).not.toHaveBeenCalled();
  });

  it("serializes concurrent credential updates per provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-concurrency-"));
    dirs.push(dir);
    const store = new KeytarCredentialStore(join(dir, "index.json"));
    const order: string[] = [];
    const first = store.modify("openai", async () => {
      await Promise.resolve();
      order.push("first");
      return { type: "api_key", key: "first" };
    });
    const second = store.modify("openai", async (current) => {
      order.push(current?.type === "api_key" && current.key ? current.key : "missing");
      return { type: "api_key", key: "second" };
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "first"]);
    await expect(store.read("openai")).resolves.toEqual({ type: "api_key", key: "second" });
  });

  it("reads one-way migration aliases registered by a provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-alias-"));
    dirs.push(dir);
    passwords.set("old-team-account", "legacy-team-key");
    const store = new KeytarCredentialStore(join(dir, "index.json"));
    store.configureAliases("team-provider", ["old-team-account"]);

    await expect(store.read("team-provider")).resolves.toEqual({
      type: "api_key",
      key: "legacy-team-key",
    });
  });

  it("rejects credential aliases shared by different providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-alias-owner-"));
    dirs.push(dir);
    const store = new KeytarCredentialStore(join(dir, "index.json"));
    store.configureAliases("first-provider", ["shared-account"]);

    expect(() => store.configureAliases("second-provider", ["shared-account"])).toThrow(
      "Credential alias is already owned by another provider",
    );
  });

  it("does not delete migration aliases during ordinary credential deletion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-alias-delete-"));
    dirs.push(dir);
    passwords.set("shared-legacy-account", "legacy-key");
    const store = new KeytarCredentialStore(join(dir, "index.json"));
    store.configureAliases("team-provider", ["shared-legacy-account"]);

    await store.delete("team-provider");

    expect(passwords.get("shared-legacy-account")).toBe("legacy-key");
  });

  it("preserves index entries when different providers update concurrently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-index-concurrency-"));
    dirs.push(dir);
    const store = new KeytarCredentialStore(join(dir, "index.json"));

    await Promise.all([
      store.modify("openai", async () => ({ type: "api_key", key: "openai" })),
      store.modify("anthropic", async () => ({ type: "api_key", key: "anthropic" })),
    ]);

    await expect(store.list()).resolves.toEqual(
      expect.arrayContaining([
        { providerId: "openai", type: "api_key" },
        { providerId: "anthropic", type: "api_key" },
      ]),
    );
  });

  it("merges reconcile results with concurrent index updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-reconcile-concurrency-"));
    dirs.push(dir);
    const store = new KeytarCredentialStore(join(dir, "index.json"));
    passwords.set("credential:openai", JSON.stringify({ type: "api_key", key: "openai-secret" }));
    let releaseReconcile!: () => void;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    let markReconcileStarted!: () => void;
    const reconcileStarted = new Promise<void>((resolve) => {
      markReconcileStarted = resolve;
    });
    keytar.getPassword.mockImplementation(async (_service: string, account: string) => {
      if (account === "credential:openai") {
        markReconcileStarted();
        await reconcileGate;
      }
      return passwords.get(account) ?? null;
    });

    const reconcile = store.reconcile(["openai"]);
    await reconcileStarted;
    await store.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-secret" }));
    releaseReconcile();
    await reconcile;

    await expect(store.list()).resolves.toEqual(
      expect.arrayContaining([
        { providerId: "openai", type: "api_key" },
        { providerId: "anthropic", type: "api_key" },
      ]),
    );
  });

  it("compensates the keytar write when the derived index cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-compensation-"));
    dirs.push(dir);
    const indexPath = join(dir, "index.json");
    mkdirSync(indexPath);
    const store = new KeytarCredentialStore(indexPath);

    await expect(
      store.modify("openai", async () => ({ type: "api_key", key: "must-roll-back" })),
    ).rejects.toThrow("Credential index is corrupt");
    expect(passwords.has("credential:openai")).toBe(false);
  });

  it("reports a corrupt index instead of silently returning an empty list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-corrupt-"));
    dirs.push(dir);
    const indexPath = join(dir, "index.json");
    writeFileSync(indexPath, "not json");
    const store = new KeytarCredentialStore(indexPath);

    await expect(store.list()).rejects.toThrow("Credential index is corrupt");
  });

  it("quarantines a corrupt index and migrates known legacy accounts during reconcile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-keytar-reconcile-"));
    dirs.push(dir);
    const indexPath = join(dir, "index.json");
    writeFileSync(indexPath, "not json");
    passwords.set("kimi", "legacy-key");
    const store = new KeytarCredentialStore(indexPath);

    const report = await store.reconcile(["moonshotai"]);

    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: "corrupt_index_quarantined" }),
    ]);
    await expect(store.list()).resolves.toEqual([{ providerId: "moonshotai", type: "api_key" }]);
    expect(passwords.has("kimi")).toBe(false);
    expect(JSON.parse(passwords.get("credential:moonshotai")!)).toEqual({
      type: "api_key",
      key: "legacy-key",
    });
  });
});
