import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadLocalModelPresets } from "../models/local-presets";

describe("local model presets", () => {
  const previousFile = process.env.OMNI_MODEL_PRESETS_FILE;
  const previousEndpoint = process.env.OMNI_TEST_LOCAL_ENDPOINT;
  const previousKeyVarName = process.env.OMNI_TEST_LOCAL_KEY_VAR_NAME;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousFile === undefined) {
      delete process.env.OMNI_MODEL_PRESETS_FILE;
    } else {
      process.env.OMNI_MODEL_PRESETS_FILE = previousFile;
    }
    if (previousEndpoint === undefined) {
      delete process.env.OMNI_TEST_LOCAL_ENDPOINT;
    } else {
      process.env.OMNI_TEST_LOCAL_ENDPOINT = previousEndpoint;
    }
    if (previousKeyVarName === undefined) {
      delete process.env.OMNI_TEST_LOCAL_KEY_VAR_NAME;
    } else {
      process.env.OMNI_TEST_LOCAL_KEY_VAR_NAME = previousKeyVarName;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads valid presets from a local JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-local-presets-"));
    tempDirs.push(dir);
    const file = join(dir, "models.json");
    process.env.OMNI_MODEL_PRESETS_FILE = file;
    process.env.OMNI_TEST_LOCAL_ENDPOINT = "https://local.example/v1";
    process.env.OMNI_TEST_LOCAL_KEY_VAR_NAME = "OMNI_TEST_LOCAL_API_KEY";

    writeFileSync(
      file,
      JSON.stringify({
        presets: [
          {
            id: "local-test-model",
            name: "Local Test Model",
            description: "Local-only test preset",
            provider: "local-provider",
            api: "openai-completions",
            endpoint: "$OMNI_TEST_LOCAL_ENDPOINT",
            model: "local-model",
            maxTokens: 1024,
            contextWindow: 4096,
            keychainAccount: "local-provider",
            apiKeyEnvVar: "${OMNI_TEST_LOCAL_KEY_VAR_NAME}",
          },
          {
            id: "",
            provider: "invalid",
          },
        ],
      }),
      "utf-8",
    );

    expect(loadLocalModelPresets()).toEqual([
      {
        id: "local-test-model",
        name: "Local Test Model",
        description: "Local-only test preset",
        provider: "local-provider",
        api: "openai-completions",
        endpoint: "https://local.example/v1",
        model: "local-model",
        maxTokens: 1024,
        contextWindow: 4096,
        keychainAccount: "local-provider",
        apiKeyEnvVar: "OMNI_TEST_LOCAL_API_KEY",
      },
    ]);
  });
});
