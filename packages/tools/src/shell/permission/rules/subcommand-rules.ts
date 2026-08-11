export const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "ls-files",
  "rev-parse",
  "describe",
  "shortlog",
]);
export const GIT_WRITE = new Set([
  "add",
  "commit",
  "stash",
  "merge",
  "checkout",
  "switch",
  "branch",
  "tag",
  "cherry-pick",
  "revert",
]);
export const GIT_EXTERNAL_ROUTINE = new Set(["push", "pull", "fetch", "clone", "submodule"]);
export const GIT_DESTRUCTIVE = new Set(["clean", "rebase", "filter-branch", "filter-repo"]);

export interface PackageManagerActions {
  routineExternal: ReadonlySet<string>;
  sensitiveExternal: ReadonlySet<string>;
}

export const PACKAGE_MANAGER_ACTIONS: Readonly<Record<string, PackageManagerActions>> = {
  npm: actions(
    ["install", "i", "ci", "remove", "rm", "uninstall", "update"],
    ["publish", "unpublish", "login", "exec"],
  ),
  pnpm: actions(
    ["install", "i", "add", "remove", "rm", "update", "up", "fetch"],
    ["publish", "unpublish", "login", "dlx", "exec"],
  ),
  yarn: actions(
    ["install", "add", "remove", "update", "up", "upgrade"],
    ["publish", "login", "dlx", "exec"],
  ),
  cargo: actions(["install", "add", "remove", "update"], ["publish", "yank", "login"]),
  go: actions(["get", "install"], []),
};

export const PACKAGE_EXECUTE = new Set([
  "run",
  "test",
  "build",
  "lint",
  "typecheck",
  "check",
  "fmt",
  "format",
  "start",
  "dev",
]);

export const DOCKER_DESTRUCTIVE = new Set(["rm", "rmi", "prune", "kill"]);
export const KUBECTL_DESTRUCTIVE = new Set(["delete", "drain"]);

function actions(
  routineExternal: readonly string[],
  sensitiveExternal: readonly string[],
): PackageManagerActions {
  return {
    routineExternal: new Set(routineExternal),
    sensitiveExternal: new Set(sensitiveExternal),
  };
}
