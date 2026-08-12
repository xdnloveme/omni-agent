import { containerClassifier } from "./container-classifier";
import { filesystemCommandClassifier } from "./filesystem-command-classifier";
import { genericCommandClassifier } from "./generic-command-classifier";
import { gitCommandClassifier } from "./git-command-classifier";
import { infrastructureClassifier } from "./infrastructure-classifier";
import { packageManagerClassifier } from "./package-manager-classifier";
import { privilegedCommandClassifier } from "./privileged-command-classifier";
import { classification, type ShellClassification, type ShellClassifier } from "./types";
import type { ShellCommandView } from "../parser";

const classifiers: readonly ShellClassifier[] = [
  privilegedCommandClassifier,
  filesystemCommandClassifier,
  gitCommandClassifier,
  packageManagerClassifier,
  containerClassifier,
  infrastructureClassifier,
  genericCommandClassifier,
].sort((left, right) => left.priority - right.priority);

export function classifyCommand(command: ShellCommandView): ShellClassification {
  for (const classifier of classifiers) {
    const result = classifier.classify(command);
    if (result) return result;
  }
  const primary = command.executableName;
  return classification("unknown", `Unknown executable: ${primary || "(empty)"}`, "shell.unknown");
}
