// Assembly values cross planning, validation and evidence boundaries. Keeping
// recursive freezing here prevents each owner from maintaining a subtly
// different immutability implementation.
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
