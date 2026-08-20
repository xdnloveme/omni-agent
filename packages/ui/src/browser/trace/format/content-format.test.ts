import { describe, expect, it } from "vitest";

interface ContentFormat {
  modelMessageKind(request: unknown, message: unknown, index: number): string;
  parseEnvironmentContext(source: string): {
    readonly revision: string;
    readonly notice: string;
    readonly workspace: { readonly cwd: string; readonly roots: readonly string[] };
    readonly time: { readonly currentDate: string; readonly timezone: string };
    readonly execution: {
      readonly platform: string;
      readonly arch: string;
      readonly shell: string;
      readonly kind: string;
    };
  } | null;
}

const contentFormat = (await import(
  new URL("./content-format.ts", import.meta.url).href
)) as ContentFormat;

describe("Trace preview content formatting", () => {
  it("uses recorded context metadata instead of text matching to identify runtime context", () => {
    const request = { manifest: { environmentFingerprint: "fingerprint" } };

    expect(contentFormat.modelMessageKind(request, { role: "user", content: "anything" }, 0)).toBe(
      "runtime-context",
    );
    expect(contentFormat.modelMessageKind(request, { role: "user", content: "anything" }, 1)).toBe(
      "user",
    );
    expect(
      contentFormat.modelMessageKind({}, { role: "user", content: "<environment_context/>" }, 0),
    ).toBe("user");
  });

  it("parses the canonical environment document into presentation fields", () => {
    expect(
      contentFormat.parseEnvironmentContext(`
        <environment_context revision="3">
          <notice>Runtime facts.</notice>
          <workspace>
            <cwd>/workspace/project</cwd>
            <roots><root>/workspace/project</root><root>/workspace/shared</root></roots>
          </workspace>
          <time><current_date>2026-08-20</current_date><timezone>Asia/Shanghai</timezone></time>
          <execution><platform>darwin</platform><arch>arm64</arch><shell>zsh</shell><kind>host</kind></execution>
        </environment_context>
      `),
    ).toEqual({
      revision: "3",
      notice: "Runtime facts.",
      workspace: {
        cwd: "/workspace/project",
        roots: ["/workspace/project", "/workspace/shared"],
      },
      time: { currentDate: "2026-08-20", timezone: "Asia/Shanghai" },
      execution: { platform: "darwin", arch: "arm64", shell: "zsh", kind: "host" },
    });
  });

  it("rejects values without the environment context root", () => {
    expect(contentFormat.parseEnvironmentContext("plain user text")).toBeNull();
  });
});
