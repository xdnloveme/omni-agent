import { PACKAGE_EXECUTE, PACKAGE_MANAGER_ACTIONS } from "../rules/subcommand-rules";
import { classification, type ShellClassifier } from "./types";
import { findPositionalArgument } from "./command-utils";

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--prefix",
  "--dir",
  "--cwd",
  "-C",
  "--workspace",
  "-w",
  "--filter",
  "-F",
]);

export const packageManagerClassifier: ShellClassifier = {
  priority: 40,
  classify(command) {
    const primary = command.executableName;
    const profile = PACKAGE_MANAGER_ACTIONS[primary];
    if (!profile) return null;
    const action = resolvePackageAction(primary, command.argumentValues);
    if (profile.routineExternal.has(action)) {
      return classification(
        "external",
        `${primary} ${action} accesses package services`,
        `shell.external.${primary}`,
        { operationClass: "routine" },
      );
    }
    if (profile.sensitiveExternal.has(action)) {
      return classification(
        "external",
        `${primary} ${action} performs a sensitive package-service operation`,
        `shell.external.${primary}`,
      );
    }
    const reason = PACKAGE_EXECUTE.has(action)
      ? `${primary} executes project code`
      : `${primary} may execute project code`;
    return classification("execute", reason, `shell.execute.${primary}`);
  },
};

function resolvePackageAction(primary: string, args: readonly string[]): string {
  const action = findPositionalArgument(args, 0, GLOBAL_OPTIONS_WITH_VALUE);
  if (!action) return "";
  if (primary !== "yarn" || action.value !== "npm") return action.value;
  return findPositionalArgument(args, action.index + 1, GLOBAL_OPTIONS_WITH_VALUE)?.value ?? "";
}
