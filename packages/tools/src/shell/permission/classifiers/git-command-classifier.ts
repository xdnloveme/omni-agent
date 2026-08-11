import {
  GIT_DESTRUCTIVE,
  GIT_EXTERNAL_ROUTINE,
  GIT_READ,
  GIT_WRITE,
} from "../rules/subcommand-rules";
import { classification, type ShellClassifier } from "./types";
import { commandArguments, commandName, findPositionalArgument } from "./command-utils";

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

export const gitCommandClassifier: ShellClassifier = {
  priority: 30,
  classify(words) {
    if (commandName(words) !== "git") return null;
    const action = resolveGitAction(words);
    if (GIT_READ.has(action)) {
      return classification("read", `git ${action} is read-only`, "shell.read.git");
    }
    if (
      GIT_DESTRUCTIVE.has(action) ||
      (action === "reset" && commandArguments(words).includes("--hard")) ||
      isDestructivePush(action, words)
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
    if (action === "remote") return classifyRemote(words);
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

function isDestructivePush(action: string, words: readonly string[]): boolean {
  if (action !== "push") return false;
  return commandArguments(words).some((argument) => {
    if (
      ["-f", "--force", "--force-with-lease", "--delete", "--mirror", "--prune"].includes(argument)
    )
      return true;
    if (argument.startsWith("--force-with-lease=")) return true;
    return /^:[^:]/.test(argument) || /^\+[^+]/.test(argument);
  });
}

function resolveGitAction(words: readonly string[]): string {
  return (
    findPositionalArgument(commandArguments(words), 0, GIT_GLOBAL_OPTIONS_WITH_VALUE)?.value ?? ""
  );
}

function classifyRemote(words: readonly string[]) {
  const args = commandArguments(words);
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
