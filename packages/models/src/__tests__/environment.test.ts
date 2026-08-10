import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeAuthContext } from "../credentials/environment";

const directories: string[] = [];
const originalProcessValue = process.env.OMNI_ENV_PRIORITY_TEST;
const originalLocalEnvironmentFile = process.env.OMNI_LOCAL_ENV_FILE;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  if (originalProcessValue === undefined) delete process.env.OMNI_ENV_PRIORITY_TEST;
  else process.env.OMNI_ENV_PRIORITY_TEST = originalProcessValue;
  if (originalLocalEnvironmentFile === undefined) delete process.env.OMNI_LOCAL_ENV_FILE;
  else process.env.OMNI_LOCAL_ENV_FILE = originalLocalEnvironmentFile;
  delete process.env.DOTENV_MULTILINE_TEST;
});

describe("model environment", () => {
  it("uses process, project, then local environment precedence without mutating process.env", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-env-"));
    directories.push(cwd);
    mkdirSync(join(cwd, ".omni-agent.local"), { recursive: true });
    writeFileSync(join(cwd, ".env"), "OMNI_ENV_PRIORITY_TEST=project\nPROJECT_ONLY=project\n");
    writeFileSync(
      join(cwd, ".omni-agent.local/.env"),
      "OMNI_ENV_PRIORITY_TEST=local\nLOCAL_ONLY=local\n",
    );
    process.env.OMNI_ENV_PRIORITY_TEST = "process";

    const context = createNodeAuthContext(cwd);
    await expect(context.env("OMNI_ENV_PRIORITY_TEST")).resolves.toBe("process");
    await expect(context.env("PROJECT_ONLY")).resolves.toBe("project");
    await expect(context.env("LOCAL_ONLY")).resolves.toBe("local");
    expect(process.env.PROJECT_ONLY).toBeUndefined();
  });

  it("uses dotenv syntax and keeps the custom file below project precedence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-dotenv-"));
    directories.push(cwd);
    writeFileSync(
      join(cwd, ".env"),
      'OMNI_ENV_PRIORITY_TEST="project quoted"\nDOTENV_MULTILINE_TEST="first\nsecond"\n',
    );
    writeFileSync(join(cwd, "custom.env"), "OMNI_ENV_PRIORITY_TEST=custom\nCUSTOM_ONLY=yes\n");
    process.env.OMNI_LOCAL_ENV_FILE = "custom.env";

    const context = createNodeAuthContext(cwd);
    await expect(context.env("OMNI_ENV_PRIORITY_TEST")).resolves.toBe("project quoted");
    await expect(context.env("DOTENV_MULTILINE_TEST")).resolves.toBe("first\nsecond");
    await expect(context.env("CUSTOM_ONLY")).resolves.toBe("yes");
    expect(process.env.DOTENV_MULTILINE_TEST).toBeUndefined();
  });
});
