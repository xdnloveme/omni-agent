import type { ShellCommandView } from "../parser";

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

export const DYNAMIC_EXECUTION_BUILTINS = new Set(["eval", "source", ".", "trap"]);

export const SHELL_INTERPRETERS = new Set(["bash", "dash", "sh", "zsh"]);

// Unquoted reserved words belong to Bash grammar and cannot name an external command.
export const SHELL_RESERVED_WORDS = new Set([
  "!",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
]);

export const SHELL_BUILTINS = new Set([
  ...SHELL_CONTEXT_COMMANDS,
  ...DYNAMIC_EXECUTION_BUILTINS,
  "alias",
  "bg",
  "bind",
  "builtin",
  "caller",
  "command",
  "compgen",
  "complete",
  "compopt",
  "declare",
  "dirs",
  "disown",
  "echo",
  "enable",
  "eval",
  "exec",
  "exit",
  "false",
  "fc",
  "fg",
  "hash",
  "history",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "readonly",
  "source",
  "suspend",
  "test",
  "time",
  "trap",
  "true",
  "typeset",
  "unalias",
  "variables",
  "[",
]);

/** Only a literal, unqualified, unshadowed name denotes an intrinsic builtin. */
export function isShellBuiltinCommand(
  command: ShellCommandView,
  functions: ReadonlySet<string>,
): boolean {
  const token = command.executable?.staticValue;
  return (
    token === command.executableName &&
    !token.includes("/") &&
    !functions.has(token) &&
    SHELL_BUILTINS.has(token)
  );
}
