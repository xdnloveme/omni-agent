import { describe, expect, it } from "vitest";
import { formatSanitizedToolInput, sanitizeSensitiveValue } from "../security";

describe("security sanitizer", () => {
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

  it("preserves token accounting while redacting credential tokens", () => {
    expect(
      sanitizeSensitiveValue({
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        estimatedInputTokens: 14,
        accessToken: "private",
        githubToken: "private",
        api_key: "private",
        clientSecretValue: "private",
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      estimatedInputTokens: 14,
      accessToken: "[REDACTED]",
      githubToken: "[REDACTED]",
      api_key: "[REDACTED]",
      clientSecretValue: "[REDACTED]",
    });
  });
});
