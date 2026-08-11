import { DOCKER_DESTRUCTIVE, KUBECTL_DESTRUCTIVE } from "../rules/subcommand-rules";
import { classification, type ShellClassifier } from "./types";
import { commandName, subcommand } from "./command-utils";

export const containerClassifier: ShellClassifier = {
  priority: 50,
  classify(words) {
    const primary = commandName(words);
    const action = subcommand(words);
    if (primary === "docker") {
      return DOCKER_DESTRUCTIVE.has(action)
        ? classification("destructive", "Removes container resources", "shell.destructive.docker")
        : classification("external", "Accesses container services", "shell.external.docker");
    }
    if (primary !== "kubectl") return null;
    return KUBECTL_DESTRUCTIVE.has(action)
      ? classification("destructive", "Changes cluster availability", "shell.destructive.kubectl")
      : classification("external", "Accesses a Kubernetes cluster", "shell.external.kubectl");
  },
};
