import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseAgentManifest } from "./agent-manifest-validator";

const repositoryRoot = join(import.meta.dirname, "../../../..");
const schemaPath = join(repositoryRoot, "schemas/agent-manifest-v2.schema.json");

describe("Agent Manifest editor schema", () => {
  it("accepts every canonical in-repository Manifest accepted by Runtime", async () => {
    const validate = await schemaValidator();
    for (const relativePath of [
      "agents/coding/agent.yaml",
      "agents/financial-analysis/agent.yaml",
      "examples/minimal-agent/agent.yaml",
    ]) {
      const path = join(repositoryRoot, relativePath);
      const source = await readFile(path, "utf8");
      const manifest = parseAgentManifest(source, path);
      expect(validate(manifest), `${relativePath}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("keeps representative structural failures aligned with Runtime validation", async () => {
    const validate = await schemaValidator();
    const canonical = parseYaml(
      await readFile(join(repositoryRoot, "examples/minimal-agent/agent.yaml"), "utf8"),
    ) as Record<string, any>;
    const invalidValues = [
      { ...canonical, maxTurns: 8 },
      { ...canonical, apiVersion: "omni-agent/v1" },
      { ...canonical, metadata: { ...canonical.metadata, id: "minimal.invalid" } },
      {
        ...canonical,
        composition: {
          ...canonical.composition,
          tools: { sequence: [{ bundle: "minimal.bundle", tool: "minimal.echo" }] },
        },
      },
    ];

    for (const value of invalidValues) {
      expect(validate(value)).toBe(false);
      expect(() => parseAgentManifest(stringifyYaml(value), "schema-parity.yaml")).toThrow();
    }
  });
});

async function schemaValidator() {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}
