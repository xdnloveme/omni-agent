import { DESTRUCTIVE_FILE_COMMANDS, WRITE_COMMANDS } from "../rules/command-rules";
import { classification, type ShellClassifier } from "./types";
import { commandName } from "./command-utils";

export const filesystemCommandClassifier: ShellClassifier = {
  priority: 20,
  classify(words, segment) {
    const primary = commandName(words);
    if (primary === "rm") {
      return /(?:^|\s)-(?:[^\s]*[rf][^\s]*)(?:\s|$)|--recursive|--force/.test(segment)
        ? classification(
            "destructive",
            "Recursively or forcibly deletes files",
            "shell.destructive.rm",
          )
        : classification("write", "Deletes filesystem entries", "shell.write.rm");
    }
    if (primary === "find" && /(?:^|\s)-(?:delete|exec|execdir)\b/.test(segment)) {
      return classification(
        "destructive",
        "find deletes files or delegates execution",
        "shell.destructive.find",
      );
    }
    if (["kill", "pkill", "killall"].includes(primary)) {
      const destructive =
        /(?:^|\s)(?:-9|-KILL|-SIGKILL)(?:\s|$)/i.test(segment) || primary === "killall";
      return destructive
        ? classification(
            "destructive",
            "Forcefully terminates processes",
            `shell.destructive.${primary}`,
          )
        : classification("execute", "Signals a local process", `shell.execute.${primary}`);
    }
    if (DESTRUCTIVE_FILE_COMMANDS.has(primary)) {
      return classification(
        "destructive",
        `${primary} can remove data`,
        `shell.destructive.${primary}`,
      );
    }
    if (!WRITE_COMMANDS.has(primary)) return null;
    const destructive =
      /(?:^|\s)-R(?:\s|$)/.test(segment) || (primary === "chmod" && /\b777\b/.test(segment));
    return destructive
      ? classification(
          "destructive",
          `${primary} makes a high-impact recursive change`,
          `shell.destructive.${primary}`,
        )
      : classification("write", `${primary} modifies local files`, `shell.write.${primary}`);
  },
};
