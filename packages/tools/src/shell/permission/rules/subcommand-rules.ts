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
export const GIT_EXTERNAL = new Set(["push", "pull", "fetch", "clone", "remote", "submodule"]);
export const GIT_DESTRUCTIVE = new Set(["clean", "rebase", "filter-branch", "filter-repo"]);

export const PACKAGE_EXTERNAL = new Set([
  "install",
  "i",
  "add",
  "remove",
  "uninstall",
  "update",
  "upgrade",
  "publish",
  "yank",
  "login",
]);
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
