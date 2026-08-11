import { GIT_DESTRUCTIVE, GIT_EXTERNAL, GIT_READ, GIT_WRITE } from "../rules/subcommand-rules";
import { classification, type ShellClassifier } from "./types";
import { commandName, subcommand } from "./command-utils";

export const gitCommandClassifier: ShellClassifier = {
  priority: 30,
  classify(words, segment) {
    if (commandName(words) !== "git") return null;
    const action = subcommand(words);
    if (GIT_READ.has(action)) {
      return classification("read", `git ${action} is read-only`, "shell.read.git");
    }
    if (
      GIT_DESTRUCTIVE.has(action) ||
      (action === "reset" && /--hard\b/.test(segment)) ||
      (action === "push" && /(?:--force|-f|--delete)\b/.test(segment))
    ) {
      return classification(
        "destructive",
        `git ${action} can discard or overwrite state`,
        "shell.destructive.git",
      );
    }
    if (GIT_EXTERNAL.has(action)) {
      return classification("external", `git ${action} accesses a remote`, "shell.external.git");
    }
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
