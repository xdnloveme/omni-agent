import { createHash } from "node:crypto";

export function digestContextValue(value: unknown): string {
  return createHash("sha256").update(serializeContextValue(value)).digest("hex");
}

export function serializeContextValue(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
