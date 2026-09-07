import { describe, expect, it } from "vitest";
import {
  ExactSensitiveTextStreamSanitizer,
  networkTargetFromUrl,
  normalizeNetworkTarget,
  redactExactSensitiveError,
  redactExactSensitiveValue,
} from "../index";

describe("network target normalization", () => {
  it("normalizes IDN, case, trailing dot, and default ports", () => {
    expect(networkTargetFromUrl("HTTPS://BÜCHER.example./path")).toEqual({
      scheme: "https",
      host: "xn--bcher-kva.example",
      port: 443,
    });
  });

  it("rejects user info and invalid target ports", () => {
    expect(() => networkTargetFromUrl("https://user:secret@example.com")).toThrow("user info");
    expect(() => normalizeNetworkTarget({ scheme: "https", host: "example.com", port: 0 })).toThrow(
      "port",
    );
  });
});

describe("ephemeral exact-value redaction", () => {
  it("redacts nested values without changing unrelated data", () => {
    expect(
      redactExactSensitiveValue(
        { stdout: "token=opaque-value", nested: ["opaque-value", "safe"] },
        { exactValues: ["opaque-value"] },
      ),
    ).toEqual({ stdout: "token=[REDACTED]", nested: ["[REDACTED]", "safe"] });
  });

  it("redacts a secret split across stream chunks", () => {
    const sanitizer = new ExactSensitiveTextStreamSanitizer({ exactValues: ["opaque-value"] });
    const output =
      sanitizer.push("before opaque-") + sanitizer.push("value after") + sanitizer.finish();
    expect(output).toBe("before [REDACTED] after");
    expect(output).not.toContain("opaque-value");
  });

  it("drops secret-bearing keys without overwriting unrelated fields", () => {
    const sanitized = redactExactSensitiveValue(
      {
        structuredContent: {
          "opaque-value": "first",
          "[REDACTED]": "keep",
          nested: { "prefix-opaque-value": "second", safe: "opaque-value" },
        },
      },
      { exactValues: ["opaque-value"] },
    );
    expect(sanitized).toEqual({
      structuredContent: { "[REDACTED]": "keep", nested: { safe: "[REDACTED]" } },
    });
    expect(JSON.stringify(sanitized)).not.toContain("opaque-value");
  });

  it("preserves coded Error behavior while redacting message, stack, and fields", () => {
    const original = Object.assign(new Error("request used access-secret"), {
      code: "transport_failed",
      detail: "Bearer access-secret",
    });
    const sanitized = redactExactSensitiveError(original, {
      exactValues: ["access-secret"],
    });
    expect(sanitized).toBeInstanceOf(Error);
    expect(sanitized).toMatchObject({
      message: "request used [REDACTED]",
      code: "transport_failed",
      detail: "Bearer [REDACTED]",
    });
    expect((sanitized as Error).stack).not.toContain("access-secret");
  });
});
