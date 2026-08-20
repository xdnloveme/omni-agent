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
