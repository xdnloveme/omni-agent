import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { TEST_HOME } = vi.hoisted(() => {
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  return { TEST_HOME: join(tmpdir(), "omni-agent-model-registry-test") };
});

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
    hostname: () => "test-host",
  };
});

import { buildModel } from "../llm";
import { getDefaultPresetForProvider, getModelPresetById, isProviderId, MODEL_PRESETS } from "../models";

describe("model registry", () => {
  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("contains the built-in provider presets", () => {
    expect(MODEL_PRESETS.map((preset) => preset.id)).toEqual([
      "anthropic-claude-sonnet-4",
      "kimi-k2.6-global",
      "kimi-k2.6-cn",
      "kimi-code-for-coding",
      "custom-openai-compatible",
    ]);
  });

  it("validates configured provider ids", () => {
    expect(isProviderId("kimi-code")).toBe(true);
    expect(isProviderId("invalid-provider")).toBe(false);
  });

  it("returns default metadata for a provider", () => {
    const preset = getDefaultPresetForProvider("kimi-cn");

    expect(preset.endpoint).toBe("https://api.moonshot.cn/v1");
    expect(preset.model).toBe("kimi-k2.6");
    expect(preset.contextWindow).toBe(256000);
  });

  it("builds Kimi Code with coding endpoint and required headers", () => {
    const model = buildModel({
      provider: "kimi-code",
      endpoint: "https://api.kimi.com/coding/v1",
      model: "kimi-for-coding",
      apiKey: "test-key",
      systemPrompt: "test",
      tools: [],
    });

    expect(getModelPresetById("kimi-code-for-coding")?.headers).toBeDefined();
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(model.contextWindow).toBe(262144);
    expect(model.headers).toMatchObject({
      "User-Agent": "kimi-code-cli/0.14.0",
      "X-Msh-Platform": "kimi_code_cli",
      "X-Msh-Version": "0.14.0",
      "X-Msh-Device-Name": "test-host",
    });
    expect(model.headers?.["X-Msh-Device-Id"]).toEqual(expect.any(String));
  });
});
