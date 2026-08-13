export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function assertJsonObject(
  value: unknown,
  label: string,
): asserts value is Record<string, JsonValue> {
  if (!isJsonValue(value) || Array.isArray(value) || value === null) {
    throw new Error(`${label} must be a JSON object`);
  }
}

export function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (
      !Reflect.ownKeys(value).every(
        (key) => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable,
      )
    ) {
      return false;
    }
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
