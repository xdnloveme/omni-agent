import { containerClassifier } from "./container-classifier";
import { filesystemCommandClassifier } from "./filesystem-command-classifier";
import { genericCommandClassifier } from "./generic-command-classifier";
import { gitCommandClassifier } from "./git-command-classifier";
import { infrastructureClassifier } from "./infrastructure-classifier";
import { packageManagerClassifier } from "./package-manager-classifier";
import { privilegedCommandClassifier } from "./privileged-command-classifier";
import { classification, type ShellClassification, type ShellClassifier } from "./types";
import { commandName } from "./command-utils";

const classifiers: readonly ShellClassifier[] = [
  privilegedCommandClassifier,
  filesystemCommandClassifier,
  gitCommandClassifier,
  packageManagerClassifier,
  containerClassifier,
  infrastructureClassifier,
  genericCommandClassifier,
].sort((left, right) => left.priority - right.priority);

export function classifyCommand(words: readonly string[], segment: string): ShellClassification {
  for (const classifier of classifiers) {
    const result = classifier.classify(words, segment);
    if (result) return result;
  }
  const primary = commandName(words);
  return classification("unknown", `Unknown executable: ${primary || "(empty)"}`, "shell.unknown");
}
