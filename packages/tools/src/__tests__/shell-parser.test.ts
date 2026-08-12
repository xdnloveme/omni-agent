import { describe, expect, it } from "vitest";
import { parseShellCommand } from "../shell/permission/parser";

describe("shell parser", () => {
  it("produces one AST for compound commands and quoted operators", () => {
    const parsed = parseShellCommand("echo 'a|b' && git status | tail -1");
    expect(parsed.segments.map(({ raw }) => raw)).toEqual(["echo 'a|b'", "git status", "tail -1"]);
    expect(parsed.segments.map(({ nextOperator }) => nextOperator)).toEqual(["&&", "|", undefined]);
    expect(parsed.segments[0]?.words.map(({ value }) => value)).toEqual(["echo", "a|b"]);
  });

  it("retains exact shell payload and redirection facts", () => {
    const wrapped = parseShellCommand("sh -c 'printf \"a;b\"'");
    expect(wrapped.segments[0]?.words[2]?.value).toBe('printf "a;b"');
    expect(parseShellCommand("gh pr view 1 2>&1")).toMatchObject({
      hasControlOperator: false,
      hasOutputRedirection: false,
      malformed: false,
    });
    expect(parseShellCommand('echo x > "notes file.txt"').redirections).toEqual([
      { operator: ">", target: "notes file.txt" },
    ]);
    expect(parseShellCommand("echo ok>output.log").redirections).toEqual([
      { operator: ">", target: "output.log" },
    ]);
  });

  it("preserves executables next to attached redirections", () => {
    const sudo = parseShellCommand("sudo>output.log");
    expect(sudo.segments[0]?.words.map(({ value }) => value)).toEqual(["sudo"]);
    expect(sudo.redirections).toEqual([{ operator: ">", target: "output.log" }]);

    const cat = parseShellCommand("cat<input.txt");
    expect(cat.segments[0]?.words.map(({ value }) => value)).toEqual(["cat"]);
    expect(cat.redirections).toEqual([{ operator: "<", target: "input.txt" }]);
  });

  it("marks dynamic and malformed syntax", () => {
    expect(parseShellCommand("echo $(whoami)").hasDynamicExecution).toBe(true);
    expect(parseShellCommand("cat <(printf value)").hasDynamicExecution).toBe(true);
    expect(parseShellCommand("echo 'open").malformed).toBe(true);
    expect(parseShellCommand("echo ok &&").malformed).toBe(true);
  });
});
