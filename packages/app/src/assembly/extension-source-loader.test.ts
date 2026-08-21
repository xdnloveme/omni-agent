import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExtensionSourceLoader } from "./extension-source-loader";
import type { ExtensionSourceReference } from "./contracts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function source(
  name: string,
  body: string,
  requirement: ExtensionSourceReference["requirement"] = "optional",
): Promise<ExtensionSourceReference> {
  const directory = await mkdtemp(join(tmpdir(), "omni-extension-source-"));
  directories.push(directory);
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, body);
  return { sourceOriginId: name, diagnosticSource: path, requirement };
}

const extension = (version: string) =>
  `({ manifest: { id: "portable", version: "${version}", apiVersion: 1 }, contributions: {} })`;

describe("LocalExtensionSourceLoader", () => {
  it("fails a required missing source and ignores an optional missing source", async () => {
    const loader = new LocalExtensionSourceLoader();
    const missing = join(tmpdir(), `omni-missing-${crypto.randomUUID()}.mjs`);

    await expect(
      loader.load([
        { sourceOriginId: "required", diagnosticSource: missing, requirement: "required" },
      ]),
    ).rejects.toThrow("Required extension source failed");
    await expect(
      loader.load([
        { sourceOriginId: "optional", diagnosticSource: missing, requirement: "optional" },
      ]),
    ).resolves.toEqual({ candidates: [], diagnostics: [] });
  });

  it("keeps an optional invalid source atomic and diagnostic-only", async () => {
    const reference = await source(
      "invalid",
      `export default [${extension("1.0.0")}, { invalid: true }];`,
    );

    await expect(new LocalExtensionSourceLoader().load([reference])).resolves.toMatchObject({
      candidates: [],
      diagnostics: [{ source: reference.diagnosticSource }],
    });
  });

  it("uses configured source order for deterministic extension replacement", async () => {
    const globalSource = await source("global", `export default ${extension("1.0.0")};`);
    const workspaceSource = await source("workspace", `export default ${extension("2.0.0")};`);

    const loaded = await new LocalExtensionSourceLoader().load([globalSource, workspaceSource]);

    expect(loaded.candidates).toMatchObject([
      {
        sourceOriginId: "workspace",
        extension: { manifest: { id: "portable", version: "2.0.0" } },
      },
    ]);
  });
});
