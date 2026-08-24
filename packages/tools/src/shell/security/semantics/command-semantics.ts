import type { ShellCommandView } from "../parser";

export type ShellEffect =
  "network_transfer" | "download" | "decode" | "interpreter" | "credential_read";

export interface ShellCommandSemantics {
  readonly pathAccess: "read" | "write" | "unknown";
  readonly effects: readonly ShellEffect[];
}

const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "pwd",
  "stat",
  "file",
  "wc",
  "grep",
  "rg",
  "fd",
  "find",
  "diff",
  "cmp",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "awk",
  "base64",
  "ps",
  "df",
  "du",
  "realpath",
  "readlink",
]);
const WRITE_COMMANDS = new Set([
  "mkdir",
  "touch",
  "cp",
  "mv",
  "ln",
  "chmod",
  "chown",
  "tee",
  "sed",
  "tar",
  "zip",
  "unzip",
  "shred",
  "truncate",
]);
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "node",
  "python",
  "python3",
  "perl",
  "ruby",
  "eval",
]);
const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "scp",
  "sftp",
  "rsync",
  "ssh",
  "brew",
  "pip",
  "pip3",
  "npx",
  "bunx",
  "gh",
  "glab",
  "docker",
  "kubectl",
  "terraform",
  "helm",
  "aws",
  "gcloud",
  "az",
  "vercel",
  "netlify",
]);
const GIT_NETWORK_ACTIONS = new Set(["push", "pull", "fetch", "clone", "submodule"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PACKAGE_OPTIONS_WITH_VALUE = new Set([
  "--prefix",
  "--dir",
  "--cwd",
  "-C",
  "--workspace",
  "-w",
  "--filter",
  "-F",
]);
const PACKAGE_NETWORK_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set([
    "view",
    "show",
    "info",
    "search",
    "outdated",
    "audit",
    "install",
    "i",
    "ci",
    "remove",
    "rm",
    "uninstall",
    "update",
    "publish",
    "unpublish",
    "login",
    "exec",
  ]),
  pnpm: new Set([
    "outdated",
    "audit",
    "install",
    "i",
    "add",
    "remove",
    "rm",
    "update",
    "up",
    "fetch",
    "publish",
    "unpublish",
    "login",
    "dlx",
  ]),
  yarn: new Set([
    "info",
    "audit",
    "install",
    "add",
    "remove",
    "update",
    "up",
    "upgrade",
    "publish",
    "login",
    "dlx",
  ]),
  cargo: new Set(["search", "install", "add", "remove", "update", "publish", "yank", "login"]),
  go: new Set(["get", "install"]),
};

export function analyzeCommandSemantics(command: ShellCommandView): ShellCommandSemantics {
  const executable = command.executableName;
  const effects: ShellEffect[] = [];
  if (INTERPRETERS.has(executable)) effects.push("interpreter");
  if (NETWORK_COMMANDS.has(executable) || usesNetworkSubcommand(command)) {
    effects.push("network_transfer");
  }
  if (executable === "curl" || executable === "wget") effects.push("download");
  if (
    (executable === "base64" &&
      command.argumentValues.some((argument) => argument === "-d" || argument === "--decode")) ||
    (executable === "openssl" && command.argumentValues.includes("base64"))
  ) {
    effects.push("decode");
  }
  return {
    pathAccess: inferPathAccess(executable),
    effects: [...new Set(effects)],
  };
}

function usesNetworkSubcommand(command: ShellCommandView): boolean {
  const executable = command.executableName;
  const action = firstPositional(
    command.argumentValues,
    executable === "git" ? GIT_OPTIONS_WITH_VALUE : PACKAGE_OPTIONS_WITH_VALUE,
  );
  if (executable === "git") return GIT_NETWORK_ACTIONS.has(action);
  return PACKAGE_NETWORK_ACTIONS[executable]?.has(action) === true;
}

function firstPositional(args: readonly string[], optionsWithValue: ReadonlySet<string>): string {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (optionsWithValue.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) return argument;
  }
  return "";
}

function inferPathAccess(executable: string): ShellCommandSemantics["pathAccess"] {
  if (READ_ONLY_COMMANDS.has(executable)) return "read";
  if (WRITE_COMMANDS.has(executable) || executable === "rm") return "write";
  return "unknown";
}
