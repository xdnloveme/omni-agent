import { DESTRUCTIVE_FILE_COMMANDS, WRITE_COMMANDS } from "../rules/command-rules";
import { findPositionalArgument } from "./command-utils";
import { classification, type ShellClassifier } from "./types";

const CHMOD_OPTIONS_WITH_VALUE = new Set(["--reference"]);

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
    if (primary === "find" && args.includes("-delete")) {
      return classification(
        "destructive",
        "find deletes matching filesystem entries",
        "shell.destructive.find",
      );
    }
    if (["kill", "pkill", "killall"].includes(primary)) {
      if (hasSignalZero(args) || args.some((argument) => argument === "-l" || argument === "-L")) {
        return classification("read", "Checks whether a process exists", `shell.read.${primary}`);
      }
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
    if (
      (primary === "sort" &&
        args.some(
          (argument) =>
            argument === "-o" || argument === "--output" || argument.startsWith("--output="),
        )) ||
      (primary === "diff" && args.some((argument) => argument.startsWith("--output=")))
    ) {
      return classification("write", `${primary} writes an output file`, `shell.write.${primary}`);
    }
    if (!WRITE_COMMANDS.has(primary)) return null;
    const readReason = readOnlyMode(primary, args);
    if (readReason) return classification("read", readReason, `shell.read.${primary}`);
    const destructive =
      (["chmod", "chown"].includes(primary) &&
        args.some((argument) => argument === "--recursive" || /^-[^-]*R/.test(argument))) ||
      (primary === "chmod" && isWorldWritableMode(args));
    return destructive
      ? classification(
          "destructive",
          `${primary} makes a high-impact recursive change`,
          `shell.destructive.${primary}`,
        )
      : classification("write", `${primary} modifies local files`, `shell.write.${primary}`);
  },
};

function hasSignalZero(args: readonly string[]): boolean {
  return args.some((argument, index) => {
    return (
      argument === "-0" ||
      argument === "--signal=0" ||
      ((argument === "-s" || argument === "--signal") && args[index + 1] === "0")
    );
  });
}

function isWorldWritableMode(args: readonly string[]): boolean {
  if (args.some((argument) => argument === "--reference" || argument.startsWith("--reference="))) {
    return false;
  }
  const mode = findPositionalArgument(args, 0, CHMOD_OPTIONS_WITH_VALUE)?.value;
  return mode === "777" || mode === "0777";
}

function readOnlyMode(primary: string, args: readonly string[]): string | null {
  if (
    primary === "sed" &&
    !args.some((argument) => /^-i(?:.*)?$|^--in-place(?:=.*)?$/.test(argument))
  ) {
    return "sed transforms input without modifying files";
  }
  if (
    primary === "tar" &&
    args.some((argument) => argument === "--list" || /^-[^-]*t/.test(argument))
  ) {
    return "tar lists archive contents";
  }
  if (
    primary === "unzip" &&
    args.some((argument) => argument === "-Z" || /^-[^-]*[lptv]/.test(argument))
  ) {
    return "unzip inspects archive contents";
  }
  if (
    primary === "zip" &&
    args.some((argument) => argument === "-sf" || argument === "--show-files")
  ) {
    return "zip lists archive contents";
  }
  return null;
}
