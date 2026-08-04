import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadLocalModelExtensions } from "../models/local-extensions";

declare global {
  var __omniLocalExtensionLoaded: string | undefined;
}

describe("local model extensions", () => {
  const previousFile = process.env.OMNI_MODEL_EXTENSION_FILE;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousFile === undefined) {
      delete process.env.OMNI_MODEL_EXTENSION_FILE;
    } else {
      process.env.OMNI_MODEL_EXTENSION_FILE = previousFile;
    }
    delete globalThis.__omniLocalExtensionLoaded;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a local extension module when configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-local-extension-"));
    tempDirs.push(dir);
    const file = join(dir, `register-${Date.now()}.mjs`);
    process.env.OMNI_MODEL_EXTENSION_FILE = file;

    writeFileSync(file, `globalThis.__omniLocalExtensionLoaded = "yes";\n`, "utf-8");

    await loadLocalModelExtensions();

    expect(globalThis.__omniLocalExtensionLoaded).toBe("yes");
  });
});
