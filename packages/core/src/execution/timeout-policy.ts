export type ToolTimeoutPolicy =
  | { kind: "none" }
  | { kind: "fixed"; timeoutMs: number }
  | {
      kind: "input";
      parameter: string;
      defaultMs: number;
      minMs: number;
      maxMs: number;
    };

export function resolveToolTimeout(
  policy: ToolTimeoutPolicy,
  input: Readonly<Record<string, unknown>>,
): number | undefined {
  if (policy.kind === "none") return undefined;
  if (policy.kind === "fixed") return policy.timeoutMs;
  const value = input[policy.parameter];
  if (value === undefined) return policy.defaultMs;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < policy.minMs ||
    value > policy.maxMs
  ) {
    throw new Error(`Invalid timeout value for ${policy.parameter}`);
  }
  return value;
}
