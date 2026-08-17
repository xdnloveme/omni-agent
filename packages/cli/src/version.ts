import { readFileSync } from "node:fs";

interface CliPackageMetadata {
  readonly version: string;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CliPackageMetadata;

export const CLI_VERSION = packageJson.version;
