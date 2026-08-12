export const STATEFUL_SHELL_BUILTINS = new Set(["cd", "export", "unset"]);
export const DYNAMIC_EXECUTION_BUILTINS = new Set(["eval", "source", "."]);

export function isApprovalFreeShellBuiltin(executable: string): boolean {
  return STATEFUL_SHELL_BUILTINS.has(executable);
}
