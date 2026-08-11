import { describe, expect, it } from "vitest";
import { parseRipgrepJson } from "../search/rg-json-parser";

function event(value: unknown): string {
  return JSON.stringify(value);
}

describe("parseRipgrepJson", () => {
  it("parses match locations, UTF-8 previews, and summary totals", () => {
    const longPreview = `prefix ${"界".repeat(300)}\n`;
    const output = [
      event({
        type: "match",
        data: {
          path: { text: "src/example.ts" },
          lines: { text: longPreview },
          line_number: 12,
          submatches: [{ start: 7, end: 10, match: { text: "界" } }],
        },
      }),
      event({ type: "summary", data: { stats: { matched_lines: 9 } } }),
      "",
    ].join("\n");

    const parsed = parseRipgrepJson(output, { allowTrailingPartial: false });

    expect(parsed.totalMatches).toBe(9);
    expect(parsed.matches[0]).toMatchObject({ path: "src/example.ts", line: 12, column: 8 });
    expect(Buffer.byteLength(parsed.matches[0].preview)).toBeLessThanOrEqual(512);
    expect(parsed.matches[0].preview).not.toContain("�");
  });

  it("ignores only a trailing partial record when process output was truncated", () => {
    const valid = event({
      type: "match",
      data: {
        path: { text: "file.ts" },
        lines: { text: "match\n" },
        line_number: 1,
        submatches: [{ start: 0 }],
      },
    });

    expect(
      parseRipgrepJson(`${valid}\n{"type":"match"`, { allowTrailingPartial: true }).matches,
    ).toHaveLength(1);
    expect(() =>
      parseRipgrepJson(`${valid}\nnot-json\n${valid}\n`, { allowTrailingPartial: true }),
    ).toThrow("invalid JSON");
  });
});
