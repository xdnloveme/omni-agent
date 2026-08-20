import type { PermissionPresentation } from "./types";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../security/sanitization";

const MAX_TITLE_LENGTH = 120;
const MAX_DETAIL_LENGTH = 500;
const MAX_REASON_LENGTH = 300;
const MAX_LABEL_LENGTH = 160;
const TRUNCATION_SUFFIX = "... (truncated)";

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
  return sanitizeSensitiveText(value, maxLength);
}

function redact(value: string): string {
  return sanitizeSensitiveText(value, Number.POSITIVE_INFINITY);
}
