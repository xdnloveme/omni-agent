import { hardDenyClassification, type ShellClassifier } from "./types";

export const privilegedCommandClassifier: ShellClassifier = {
  priority: 10,
  classify(command) {
    const primary = command.executableName;
    if (!["shutdown", "reboot", "halt", "poweroff"].includes(primary)) return null;
    return hardDenyClassification("Controls host power state", "shell.hard.power");
  },
};
