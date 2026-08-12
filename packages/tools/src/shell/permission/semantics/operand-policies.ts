export type PathOperandPolicy =
  "generic" | "text_only" | { kind: "search"; patternOperands: number };

const OPERAND_POLICIES: Readonly<Record<string, PathOperandPolicy>> = {
  echo: "text_only",
  printf: "text_only",
  grep: { kind: "search", patternOperands: 1 },
  rg: { kind: "search", patternOperands: 1 },
};

export function pathOperandPolicy(executable: string): PathOperandPolicy {
  return OPERAND_POLICIES[executable] ?? "generic";
}
