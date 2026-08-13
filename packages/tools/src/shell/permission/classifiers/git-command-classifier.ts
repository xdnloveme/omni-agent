import {
  GIT_DESTRUCTIVE,
  GIT_EXTERNAL_ROUTINE,
  GIT_READ,
  GIT_WRITE,
} from "../rules/subcommand-rules";
import { classification, type ShellClassifier } from "./types";
import { findPositionalArgument, hasOption } from "./command-utils";
import type { ShellCommandView } from "../parser";

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

export const gitCommandClassifier: ShellClassifier = {
  priority: 30,
  classify(command) {
    if (command.executableName !== "git") return null;
    const action = resolveGitAction(command);
    if (GIT_READ.has(action)) {
      return classification("read", `git ${action} is read-only`, "shell.read.git");
    }
    const readOnlyReason = readOnlyGitMode(action, command.argumentValues);
    if (readOnlyReason) return classification("read", readOnlyReason, "shell.read.git");
    if (
      GIT_DESTRUCTIVE.has(action) ||
      (action === "reset" && command.argumentValues.includes("--hard")) ||
      isDestructivePush(action, command)
    ) {
      return classification(
        "destructive",
        `git ${action} can discard or overwrite state`,
        "shell.destructive.git",
      );
    }
    if (GIT_EXTERNAL_ROUTINE.has(action)) {
      return classification("external", `git ${action} accesses a remote`, "shell.external.git", {
        operationClass: "routine",
      });
    }
    if (action === "remote") return classifyRemote(command);
    if (GIT_WRITE.has(action) || action === "reset") {
      return classification("write", `git ${action} changes local state`, "shell.write.git");
    }
    return classification(
      "unknown",
      `Unknown git subcommand: ${action || "(none)"}`,
      "shell.unknown.git",
    );
  },
};

function isDestructivePush(action: string, command: ShellCommandView): boolean {
  if (action !== "push") return false;
  if (hasDryRun(command.argumentValues)) return false;
  return command.argumentValues.some((argument) => {
    if (
      ["-f", "--force", "--force-with-lease", "--delete", "--mirror", "--prune"].includes(argument)
    )
      return true;
    if (argument.startsWith("--force-with-lease=")) return true;
    return /^:[^:]/.test(argument) || /^\+[^+]/.test(argument);
  });
}

function readOnlyGitMode(action: string, args: readonly string[]): string | null {
  if (action === "clean" && hasDryRun(args)) return "git clean previews removable files";
  if (action === "rebase" && args.includes("--show-current-patch")) {
    return "git rebase displays the current patch";
  }
  if (
    action === "branch" &&
    (args.length === 1 || hasAnyFlag(args, ["--list", "-l", "-a", "-r"]))
  ) {
    return "git branch lists local references";
  }
  if (action === "tag" && (args.length === 1 || hasAnyFlag(args, ["--list", "-l"]))) {
    return "git tag lists tags";
  }
  if (action === "stash" && ["list", "show"].includes(args[args.indexOf("stash") + 1] ?? "")) {
    return "git stash inspects saved changes";
  }
  return null;
}

function hasDryRun(args: readonly string[]): boolean {
  return args.includes("-n") || hasOption(args, "--dry-run");
}

function hasAnyFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some((argument) => flags.includes(argument));
}

function resolveGitAction(command: ShellCommandView): string {
  return (
    findPositionalArgument(command.argumentValues, 0, GIT_GLOBAL_OPTIONS_WITH_VALUE)?.value ?? ""
  );
}

function classifyRemote(command: ShellCommandView) {
  const args = command.argumentValues;
  const remoteIndex = args.indexOf("remote");
  const action = findPositionalArgument(args, remoteIndex + 1)?.value;
  if (!action || action === "get-url") {
    return classification("read", "git remote inspects local configuration", "shell.read.git");
  }
  if (action === "show") {
    return classification("external", "git remote show may access a remote", "shell.external.git", {
      operationClass: "routine",
    });
  }
  return classification(
    "external",
    `git remote ${action} changes remote configuration`,
    "shell.external.git",
  );
}
