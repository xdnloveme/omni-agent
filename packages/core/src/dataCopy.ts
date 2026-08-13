export function cloneData<T>(value: T): T {
  return structuredClone(value);
}
