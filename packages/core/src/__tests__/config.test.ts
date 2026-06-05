import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock os.homedir to use a temp directory
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: vi.fn(),
  };
});

import { homedir } from "node:os";
import { loadConfig, saveConfig, getConfigDir, type OmniConfig } from "../config";

const mockedHomedir = vi.mocked(homedir);

describe("config", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "omni-agent-test-"));
    mockedHomedir.mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("should save and load config (round-trip)", () => {
    const config: OmniConfig = {
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-4-20250514",
    };

    saveConfig(config);
    const loaded = loadConfig();

    expect(loaded).toEqual(config);
  });

  it("should return null when config file does not exist", () => {
    const loaded = loadConfig();
    expect(loaded).toBeNull();
  });

  it("should return null when config file contains invalid JSON", () => {
    // Create the config dir and write garbage
    getConfigDir();
    const configPath = join(tempHome, ".omni-agent", "config.json");
    writeFileSync(configPath, "not valid json {{{", "utf-8");

    const loaded = loadConfig();
    expect(loaded).toBeNull();
  });

  it("should return null when config is missing required fields", () => {
    getConfigDir();
    const configPath = join(tempHome, ".omni-agent", "config.json");
    writeFileSync(configPath, JSON.stringify({ provider: "anthropic" }), "utf-8");

    const loaded = loadConfig();
    expect(loaded).toBeNull();
  });

  it("should return null when provider is invalid", () => {
    getConfigDir();
    const configPath = join(tempHome, ".omni-agent", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: "invalid_provider",
        endpoint: "https://example.com",
        model: "some-model",
      }),
      "utf-8",
    );

    const loaded = loadConfig();
    expect(loaded).toBeNull();
  });

  it("should auto-create config directory when it does not exist", () => {
    const configDir = getConfigDir();

    expect(existsSync(configDir)).toBe(true);
    expect(configDir).toBe(join(tempHome, ".omni-agent"));
  });
});
