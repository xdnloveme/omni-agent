import { DOCKER_DESTRUCTIVE, KUBECTL_DESTRUCTIVE } from "../rules/subcommand-rules";
import { classification, type ShellClassifier } from "./types";
import { findPositionalArgument, hasOption } from "./command-utils";

const DOCKER_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--config",
  "--context",
  "-H",
  "--host",
  "-l",
  "--log-level",
]);
const KUBECTL_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--cluster",
  "--context",
  "--kubeconfig",
  "-n",
  "--namespace",
  "-s",
  "--server",
  "--token",
  "--user",
]);
const DOCKER_COMPOSE_OPTIONS_WITH_VALUE = new Set([
  "--ansi",
  "--env-file",
  "-f",
  "--file",
  "--parallel",
  "-p",
  "--profile",
  "--progress",
  "--project-directory",
  "--project-name",
]);

export const containerClassifier: ShellClassifier = {
  priority: 50,
  classify(command) {
    const primary = command.executableName;
    if (primary === "docker") {
      const action = dockerAction(command.argumentValues);
      if (action === "kill" && hasSignalZero(command.argumentValues)) {
        return classification("external_read", "Checks container state", "shell.read.docker");
      }
      return DOCKER_DESTRUCTIVE.has(action)
        ? classification("destructive", "Removes container resources", "shell.destructive.docker")
        : classification("external", "Accesses container services", "shell.external.docker");
    }
    if (primary !== "kubectl") return null;
    const action =
      findPositionalArgument(command.argumentValues, 0, KUBECTL_GLOBAL_OPTIONS_WITH_VALUE)?.value ??
      "";
    if (action === "delete" && hasDryRun(command.argumentValues)) {
      return classification(
        "external_read",
        "Previews a Kubernetes deletion",
        "shell.read.kubectl",
      );
    }
    return KUBECTL_DESTRUCTIVE.has(action)
      ? classification("destructive", "Changes cluster availability", "shell.destructive.kubectl")
      : classification("external", "Accesses a Kubernetes cluster", "shell.external.kubectl");
  },
};

function dockerAction(args: readonly string[]): string {
  const groupEntry = findPositionalArgument(args, 0, DOCKER_GLOBAL_OPTIONS_WITH_VALUE);
  if (!groupEntry) return "";
  const group = groupEntry.value;
  const action =
    findPositionalArgument(
      args,
      groupEntry.index + 1,
      group === "compose" ? DOCKER_COMPOSE_OPTIONS_WITH_VALUE : undefined,
    )?.value ?? "";
  if (group === "container" && ["rm", "kill", "prune"].includes(action)) return action;
  if (
    ["image", "network", "volume", "builder"].includes(group) &&
    ["rm", "prune"].includes(action)
  ) {
    return action === "rm" && group === "image" ? "rmi" : action;
  }
  if (group === "system" && action === "prune") return "prune";
  if (group === "compose") {
    return ["down", "kill", "rm"].includes(action) ? "rm" : action || group;
  }
  return group;
}

function hasSignalZero(args: readonly string[]): boolean {
  return args.some(
    (argument, index) =>
      argument === "--signal=0" || (argument === "--signal" && args[index + 1] === "0"),
  );
}

function hasDryRun(args: readonly string[]): boolean {
  return (
    hasOption(args, "--dry-run") ||
    args.some((argument, index) => argument === "--server-dry-run" && args[index + 1] !== "false")
  );
}
