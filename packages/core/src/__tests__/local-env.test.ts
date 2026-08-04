import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("local env", () => {
  const previousLocalEnvFile = process.env.OMNI_LOCAL_ENV_FILE;
  const previousValue = process.env.OMNI_TEST_ENV_VALUE;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousLocalEnvFile === undefined) {
      delete process.env.OMNI_LOCAL_ENV_FILE;
    } else {
      process.env.OMNI_LOCAL_ENV_FILE = previousLocalEnvFile;
    }
    if (previousValue === undefined) {
      delete process.env.OMNI_TEST_ENV_VALUE;
    } else {
      process.env.OMNI_TEST_ENV_VALUE = previousValue;
    }
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads local env variables without overwriting existing values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-local-env-"));
    tempDirs.push(dir);
    const file = join(dir, ".env");
    process.env.OMNI_LOCAL_ENV_FILE = file;
    process.env.OMNI_TEST_ENV_VALUE = "from-shell";

    writeFileSync(file, "OMNI_TEST_ENV_VALUE=from-file\nOMNI_TEST_ENV_SECOND=second\n", "utf-8");

    const { loadLocalEnv } = await import("../models/local-env");
    loadLocalEnv();

    expect(process.env.OMNI_TEST_ENV_VALUE).toBe("from-shell");
    expect(process.env.OMNI_TEST_ENV_SECOND).toBe("second");
    delete process.env.OMNI_TEST_ENV_SECOND;
  });
});
