import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeAuthContext } from "../credentials/environment";

const directories: string[] = [];
const originalProcessValue = process.env.OMNI_ENV_PRIORITY_TEST;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  if (originalProcessValue === undefined) delete process.env.OMNI_ENV_PRIORITY_TEST;
  else process.env.OMNI_ENV_PRIORITY_TEST = originalProcessValue;
  delete process.env.DOTENV_MULTILINE_TEST;
});

describe("model environment", () => {
  it("uses process, project, then global environment precedence without mutating process.env", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-env-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-model-global-env-"));
    directories.push(cwd, globalDirectory);
    writeFileSync(join(cwd, ".env"), "OMNI_ENV_PRIORITY_TEST=project\nPROJECT_ONLY=project\n");
    writeFileSync(
      join(globalDirectory, ".env"),
      "OMNI_ENV_PRIORITY_TEST=global\nGLOBAL_ONLY=global\n",
    );
    process.env.OMNI_ENV_PRIORITY_TEST = "process";

    const context = createNodeAuthContext(cwd, globalDirectory);
    await expect(context.env("OMNI_ENV_PRIORITY_TEST")).resolves.toBe("process");
    await expect(context.env("PROJECT_ONLY")).resolves.toBe("project");
    await expect(context.env("GLOBAL_ONLY")).resolves.toBe("global");
    expect(process.env.PROJECT_ONLY).toBeUndefined();
  });

  it("uses dotenv syntax and keeps the global file below project precedence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-dotenv-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-global-dotenv-"));
    directories.push(cwd, globalDirectory);
    writeFileSync(
      join(cwd, ".env"),
      'OMNI_ENV_PRIORITY_TEST="project quoted"\nDOTENV_MULTILINE_TEST="first\nsecond"\n',
    );
    writeFileSync(
      join(globalDirectory, ".env"),
      "OMNI_ENV_PRIORITY_TEST=global\nGLOBAL_ONLY=yes\n",
    );

    const context = createNodeAuthContext(cwd, globalDirectory);
    await expect(context.env("OMNI_ENV_PRIORITY_TEST")).resolves.toBe("project quoted");
    await expect(context.env("DOTENV_MULTILINE_TEST")).resolves.toBe("first\nsecond");
    await expect(context.env("GLOBAL_ONLY")).resolves.toBe("yes");
    expect(process.env.DOTENV_MULTILINE_TEST).toBeUndefined();
  });
});

it("isolates explicit authentication values from process startup and ambient credentials", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "omni-auth-isolation-"));
  try {
    writeFileSync(join(cwd, ".env"), "UNDECLARED_SECRET=ambient\n");
    const startup = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    const values = {
      HOME: "credential-home",
      PATH: "credential-path",
      NODE_OPTIONS: "credential-options",
    };
    const context = createNodeAuthContext(cwd, cwd, values);
    values.HOME = "changed-after-binding";
    await expect(context.env("HOME")).resolves.toBe("credential-home");
    await expect(context.env("PATH")).resolves.toBe("credential-path");
    await expect(context.env("NODE_OPTIONS")).resolves.toBe("credential-options");
    await expect(context.env("UNDECLARED_SECRET")).resolves.toBeUndefined();
    expect({
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    }).toEqual(startup);
    await expect(createNodeAuthContext(cwd, cwd, {}).env("HOME")).resolves.toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
