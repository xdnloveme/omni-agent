const DEFAULT_MAX_STRING_LENGTH = 500;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FIELDS = 100;
const TRUNCATION_SUFFIX = "... (truncated)";
const SENSITIVE_KEY_FRAGMENT =
  /authorization|cookie|password|passwd|secret|api[_-]?key|credential|private[_-]?key/i;
const TOKEN_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "csrftoken",
  "xsrftoken",
]);

export interface SanitizationOptions {
  readonly hiddenKeys?: readonly string[];
  readonly maxStringLength?: number;
  readonly maxDepth?: number;
  readonly maxFields?: number;
}

export interface SensitiveValueSet {
  readonly exactValues: readonly string[];
}

const EXACT_VALUE_REDACTION = "[REDACTED]";

export function redactExactSensitiveText(value: string, sensitive?: SensitiveValueSet): string {
  let result = value;
  for (const secret of normalizeExactValues(sensitive)) {
    result = result.split(secret).join(EXACT_VALUE_REDACTION);
  }
  return result;
}

export function redactExactSensitiveValue(value: unknown, sensitive?: SensitiveValueSet): unknown {
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return redactExactSensitiveText(current, sensitive);
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    // Drop secret-bearing keys instead of renaming them: redacted names can collide.
    return Object.fromEntries(
      Object.entries(current)
        .filter(([key]) => redactExactSensitiveText(key, sensitive) === key)
        .map(([key, item]) => [key, visit(item)]),
    );
  };
  return visit(value);
}

export function redactExactSensitiveError(error: unknown, sensitive?: SensitiveValueSet): unknown {
  if (!(error instanceof Error)) return redactExactSensitiveValue(error, sensitive);
  const sanitized = new Error(redactExactSensitiveText(error.message, sensitive), {
    ...(error.cause === undefined
      ? {}
      : { cause: redactExactSensitiveError(error.cause, sensitive) }),
  });
  sanitized.name = error.name;
  if (error.stack) sanitized.stack = redactExactSensitiveText(error.stack, sensitive);
  Object.assign(sanitized, redactExactSensitiveValue({ ...error }, sensitive));
  return sanitized;
}

/** Redacts exact runtime secrets even when a secret spans adjacent stream chunks. */
export class ExactSensitiveTextStreamSanitizer {
  private pending = "";
  private readonly overlap: number;

  constructor(private readonly sensitive: SensitiveValueSet) {
    this.overlap = Math.max(0, ...normalizeExactValues(sensitive).map((value) => value.length - 1));
  }

  push(chunk: string): string {
    const combined = this.pending + chunk;
    let emitLength = Math.max(0, combined.length - this.overlap);
    for (const secret of normalizeExactValues(this.sensitive)) {
      let match = combined.indexOf(secret);
      while (match >= 0) {
        if (match < emitLength && match + secret.length > emitLength) emitLength = match;
        match = combined.indexOf(secret, match + 1);
      }
    }
    const emitted = combined.slice(0, emitLength);
    this.pending = combined.slice(emitLength);
    return redactExactSensitiveText(emitted, this.sensitive);
  }

  finish(): string {
    const final = redactExactSensitiveText(this.pending, this.sensitive);
    this.pending = "";
    return final;
  }
}

export function sanitizeSensitiveText(
  value: string,
  maxLength = DEFAULT_MAX_STRING_LENGTH,
): string {
  const clean = redact(
    value
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""),
  );
  if (!Number.isFinite(maxLength) || clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`;
}

export function sanitizeSensitiveValue(
  value: unknown,
  hiddenKeysOrOptions: readonly string[] | SanitizationOptions = [],
): unknown {
  const options: SanitizationOptions = Array.isArray(hiddenKeysOrOptions)
    ? { hiddenKeys: hiddenKeysOrOptions }
    : (hiddenKeysOrOptions as SanitizationOptions);
  const hidden = new Set(options.hiddenKeys ?? []);
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFields = options.maxFields ?? DEFAULT_MAX_FIELDS;
  const seen = new WeakSet<object>();
  let fields = 0;

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > maxDepth) return "[TRUNCATED]";
    if (typeof current === "string") return sanitizeSensitiveText(current, maxStringLength);
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "bigint") return current.toString();
    if (
      typeof current === "undefined" ||
      typeof current === "function" ||
      typeof current === "symbol"
    ) {
      return null;
    }
    if (typeof current !== "object") return current;
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) {
      const result = current.slice(0, maxFields).map((item) => visit(item, depth + 1));
      seen.delete(current);
      return result;
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      if (++fields > maxFields) {
        output.__truncated__ = true;
        break;
      }
      output[key] = hidden.has(key) || isSensitiveKey(key) ? "[REDACTED]" : visit(item, depth + 1);
    }
    seen.delete(current);
    return output;
  };

  return visit(value, 0);
}

export function sanitizeTracePayload(value: unknown, hiddenKeys: readonly string[] = []): unknown {
  return sanitizeSensitiveValue(value, {
    hiddenKeys,
    maxStringLength: Number.POSITIVE_INFINITY,
    maxDepth: 64,
    maxFields: 1_000_000,
  });
}

export function formatSanitizedToolInput(
  input: Record<string, unknown>,
  hiddenKeys: readonly string[] = [],
): string {
  const rendered = JSON.stringify(sanitizeSensitiveValue(input, hiddenKeys));
  return sanitizeSensitiveText(rendered, DEFAULT_MAX_STRING_LENGTH);
}

function redact(value: string): string {
  return value
    .replace(
      /\b(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)\s*[:=]\s*([^\s&]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /([?&](?:token|key|secret|password|authorization|credential)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
}

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_FRAGMENT.test(key)) return true;
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "token" || TOKEN_KEYS.has(normalized) || normalized.endsWith("token");
}

function normalizeExactValues(sensitive?: SensitiveValueSet): readonly string[] {
  return [...new Set((sensitive?.exactValues ?? []).filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}
