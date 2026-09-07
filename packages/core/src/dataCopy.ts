export function cloneData<T>(value: T): T {
  return structuredClone(value);
}

/** Freeze detached runtime data; freezing before traversal also handles cyclic object graphs. */
export function freezeData<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) freezeData(nested);
  return value;
}
