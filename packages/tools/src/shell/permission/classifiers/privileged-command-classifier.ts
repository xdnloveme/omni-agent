import { classification, type ShellClassifier } from "./types";
import { commandName } from "./command-utils";

export const privilegedCommandClassifier: ShellClassifier = {
  priority: 10,
  classify(words) {
    const primary = commandName(words);
    if (!["shutdown", "reboot", "halt", "poweroff"].includes(primary)) return null;
    return classification(
      "privileged",
      "Controls host power state",
      "shell.hard.power",
      "hard_deny",
    );
  },
};
