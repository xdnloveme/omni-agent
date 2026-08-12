import type { PermissionPresentation } from "./types";

const MAX_TITLE_LENGTH = 120;
const MAX_DETAIL_LENGTH = 500;
const MAX_REASON_LENGTH = 300;
const MAX_LABEL_LENGTH = 160;
const MAX_DEPTH = 6;
const MAX_FIELDS = 100;
const TRUNCATION_SUFFIX = "... (truncated)";
const SENSITIVE_KEY = /authorization|password|passwd|secret|token|api[_-]?key/i;

export function sanitizePermissionPresentation(
  presentation: PermissionPresentation,
): PermissionPresentation {
  return {
    title: redact(sanitize(presentation.title, MAX_TITLE_LENGTH)),
    ...(presentation.detail
      ? { detail: redact(sanitize(presentation.detail, MAX_DETAIL_LENGTH)) }
      : {}),
    reason: redact(sanitize(presentation.reason, MAX_REASON_LENGTH)),
  };
}

export function sanitizePermissionLabel(label: string): string {
  return redact(sanitize(label, MAX_LABEL_LENGTH));
}

export function sanitizeSensitiveValue(
  value: unknown,
  hiddenKeys: readonly string[] = [],
): unknown {
  const hidden = new Set(hiddenKeys);
  let fields = 0;
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return "[TRUNCATED]";
    if (typeof current === "string") return redact(sanitize(current, MAX_DETAIL_LENGTH));
    if (current === null || typeof current !== "object") return current;
    if (Array.isArray(current))
      return current.slice(0, MAX_FIELDS).map((item) => visit(item, depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      if (++fields > MAX_FIELDS) {
        output.__truncated__ = true;
        break;
      }
      output[key] =
        hidden.has(key) || SENSITIVE_KEY.test(key) ? "[REDACTED]" : visit(item, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

export function formatSanitizedToolInput(
  input: Record<string, unknown>,
  hiddenKeys: readonly string[] = [],
): string {
  const rendered = JSON.stringify(sanitizeSensitiveValue(input, hiddenKeys));
  return rendered.length <= MAX_DETAIL_LENGTH
    ? rendered
    : `${rendered.slice(0, MAX_DETAIL_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function sanitize(value: string, maxLength: number): string {
  const clean = value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function redact(value: string): string {
  return value
    .replace(
      /\b(authorization|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*([^\s&]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, "$1[REDACTED]");
}
