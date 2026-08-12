import { describe, expect, it } from "vitest";
import { parseShellProgram } from "../shell/permission/parser";

describe("shell parser", () => {
  it("preserves compound and nested execution structure", () => {
    const program = parseShellProgram('f=$(gh api x); gh api "$f" | base64 -d | head');
    expect(program.status).toBe("complete");
    expect(program.body.map(({ kind }) => kind)).toEqual(["assignment", "pipeline"]);
    expect(program.body[0]).toMatchObject({ kind: "assignment", nested: [{ status: "complete" }] });
  });

  it("distinguishes executable substitutions from ordinary dynamic arguments", () => {
    const argument = parseShellProgram('echo "$(date)"').body[0];
    expect(argument).toMatchObject({
      kind: "command",
      command: { executableName: "echo", nested: [{ status: "complete" }] },
    });

    const executable = parseShellProgram("$(getcmd) value").body[0];
    expect(executable).toMatchObject({
      kind: "command",
      command: { executableName: "", nested: [{ status: "complete" }] },
    });
  });

  it("keeps quoted heredoc inert and exposes unquoted substitutions", () => {
    const quoted = parseShellProgram('cat <<"EOF"\n$(sudo id)\nEOF').body[0];
    const expanded = parseShellProgram("cat <<EOF\n$(sudo id)\nEOF").body[0];
    expect(quoted).toMatchObject({ kind: "redirected", nested: [] });
    expect(expanded).toMatchObject({ kind: "redirected", nested: [{ status: "complete" }] });
  });

  it("marks malformed syntax as partial", () => {
    expect(parseShellProgram("echo 'open").status).toBe("partial");
  });

  it("does not treat file-descriptor duplication as a file target", () => {
    const statement = parseShellProgram("gh pr view 1 2>&1").body[0];
    expect(statement).toMatchObject({ kind: "redirected" });
    expect(statement?.kind === "redirected" ? statement.redirections : []).toEqual([
      { operator: ">&", sourceFd: 2 },
    ]);
  });

  it("preserves empty assignments and decodes static shell escapes", () => {
    expect(parseShellProgram("X=; cat /tmp/a\\ b; cat ${HOME}/x")).toMatchObject({
      status: "complete",
      body: [
        { kind: "assignment", assignment: { name: "X", value: { staticValue: "" } } },
        { kind: "command", command: { argumentValues: ["/tmp/a b"] } },
        {
          kind: "command",
          command: {
            arguments: [
              {
                parts: [
                  { kind: "parameter", name: "HOME" },
                  { kind: "literal", value: "/x" },
                ],
              },
            ],
          },
        },
      ],
    });
  });
});
