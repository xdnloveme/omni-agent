export const SHELL_CONTEXT_COMMANDS = new Set([
  ":",
  "break",
  "cd",
  "continue",
  "export",
  "getopts",
  "help",
  "jobs",
  "read",
  "return",
  "set",
  "shift",
  "shopt",
  "times",
  "type",
  "ulimit",
  "umask",
  "unset",
  "wait",
]);

const APPROVAL_FREE_SHELL_BUILTINS = new Set([
  ...SHELL_CONTEXT_COMMANDS,
  "echo",
  "false",
  "printf",
  "pwd",
  "test",
  "true",
]);
export const DYNAMIC_EXECUTION_BUILTINS = new Set(["eval", "source", ".", "trap"]);

export function isApprovalFreeShellBuiltin(executable: string): boolean {
  return APPROVAL_FREE_SHELL_BUILTINS.has(executable);
}
