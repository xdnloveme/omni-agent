import { DESTRUCTIVE_FILE_COMMANDS, WRITE_COMMANDS } from "../rules/command-rules";
import { classification, type ShellClassifier } from "./types";

export const filesystemCommandClassifier: ShellClassifier = {
  priority: 20,
  classify(command) {
    const primary = command.executableName;
    const args = command.argumentValues;
    if (primary === "rm") {
      return args.some(
        (arg) => arg === "--recursive" || arg === "--force" || /^-[^-]*[rf]/.test(arg),
      )
        ? classification(
            "destructive",
            "Recursively or forcibly deletes files",
            "shell.destructive.rm",
          )
        : classification("write", "Deletes filesystem entries", "shell.write.rm");
    }
    if (primary === "find" && args.some((arg) => ["-delete", "-exec", "-execdir"].includes(arg))) {
      return classification(
        "destructive",
        "find deletes files or delegates execution",
        "shell.destructive.find",
      );
    }
    if (["kill", "pkill", "killall"].includes(primary)) {
      const destructive =
        args.some((arg) => /^(?:-9|-KILL|-SIGKILL)$/i.test(arg)) || primary === "killall";
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
    const destructive = args.includes("-R") || (primary === "chmod" && args.includes("777"));
    return destructive
      ? classification(
          "destructive",
          `${primary} makes a high-impact recursive change`,
          `shell.destructive.${primary}`,
        )
      : classification("write", `${primary} modifies local files`, `shell.write.${primary}`);
  },
};
