import { describe, expect, it } from "vitest";
import {
  formatSanitizedToolInput,
  sanitizePermissionPresentation,
  sanitizeSensitiveValue,
} from "../permissions";

describe("permission sanitizer", () => {
  it("redacts nested secrets, URL query values, and descriptor-hidden fields", () => {
    const sanitized = sanitizeSensitiveValue(
      {
        headers: { authorization: "Bearer private", nested: [{ api_key: "private" }] },
        url: "https://example.test/path?token=private&visible=yes",
        content: "private file body",
      },
      ["content"],
    );

    expect(sanitized).toEqual({
      headers: { authorization: "[REDACTED]", nested: [{ api_key: "[REDACTED]" }] },
      url: "https://example.test/path?token=[REDACTED]&visible=yes",
      content: "[REDACTED]",
    });
    expect(formatSanitizedToolInput(sanitized as Record<string, unknown>)).not.toContain("private");
  });

  it("sanitizes every presentation field", () => {
    expect(
      sanitizePermissionPresentation({
        title: "Run\u001b[31m token=private",
        detail: "https://example.test/?password=private",
        reason: "authorization: Bearer-private",
      }),
    ).toEqual({
      title: "Run token=[REDACTED]",
      detail: "https://example.test/?password=[REDACTED]",
      reason: "authorization=[REDACTED]",
    });
  });
});
