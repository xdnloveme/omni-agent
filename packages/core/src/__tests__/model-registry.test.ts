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
    const presetIds = MODEL_PRESETS.map((preset) => preset.id);

    expect(presetIds).toEqual(
      expect.arrayContaining([
        "openai-gpt-5.5",
        "openai-gpt-5.4-mini",
        "anthropic-claude-fable-5",
        "anthropic-claude-opus-4.8",
        "anthropic-claude-opus-4.7",
        "anthropic-claude-opus-4.6",
        "anthropic-claude-sonnet-4",
        "google-gemini-3.1-pro-preview",
        "google-gemini-3.5-flash",
        "mistral-large-latest",
        "deepseek-chat",
        "qwen3.6-plus",
        "kimi-k2.6-global",
        "kimi-k2.6-cn",
        "kimi-code-for-coding",
        "openrouter-claude-opus-4.7",
        "custom-openai-compatible",
      ]),
    );
    expect(presetIds.some((id) => id.includes("grok"))).toBe(false);
  });

  it("validates configured provider ids", () => {
    expect(isProviderId("openai")).toBe(true);
    expect(isProviderId("google")).toBe(true);
    expect(isProviderId("mistral")).toBe(true);
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("qwen")).toBe(true);
    expect(isProviderId("openrouter")).toBe(true);
    expect(isProviderId("kimi-code")).toBe(true);
    expect(isProviderId("xai")).toBe(false);
    expect(isProviderId("invalid-provider")).toBe(false);
  });

  it("returns default metadata for a provider", () => {
    const preset = getDefaultPresetForProvider("kimi-cn");

    expect(preset.endpoint).toBe("https://api.moonshot.cn/v1");
    expect(preset.model).toBe("kimi-k2.6");
    expect(preset.contextWindow).toBe(256000);
  });

  it("returns defaults for newly added providers", () => {
    expect(getDefaultPresetForProvider("openai")).toMatchObject({
      api: "openai-responses",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5.5",
      contextWindow: 1000000,
    });
    expect(getDefaultPresetForProvider("anthropic")).toMatchObject({
      api: "anthropic-messages",
      model: "claude-fable-5",
      contextWindow: 1000000,
    });
    expect(getDefaultPresetForProvider("google")).toMatchObject({
      api: "google-generative-ai",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.1-pro-preview",
    });
    expect(getDefaultPresetForProvider("mistral")).toMatchObject({
      api: "mistral-conversations",
      endpoint: "https://api.mistral.ai",
      model: "mistral-large-latest",
    });
    expect(getDefaultPresetForProvider("deepseek")).toMatchObject({
      api: "openai-completions",
      endpoint: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    expect(getDefaultPresetForProvider("qwen")).toMatchObject({
      api: "openai-completions",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.6-plus",
    });
    expect(getDefaultPresetForProvider("openrouter")).toMatchObject({
      api: "openai-completions",
      endpoint: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-opus-4.7",
    });
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
