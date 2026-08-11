import { PACKAGE_EXECUTE, PACKAGE_EXTERNAL } from "../rules/subcommand-rules";
import { classification, type ShellClassifier } from "./types";
import { commandName, subcommand } from "./command-utils";

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "cargo", "go"]);

export const packageManagerClassifier: ShellClassifier = {
  priority: 40,
  classify(words) {
    const primary = commandName(words);
    if (!PACKAGE_MANAGERS.has(primary)) return null;
    const action = subcommand(words);
    if (PACKAGE_EXTERNAL.has(action) || ["dlx", "exec"].includes(action)) {
      return classification(
        "external",
        `${primary} ${action} accesses package services`,
        `shell.external.${primary}`,
      );
    }
    const reason = PACKAGE_EXECUTE.has(action)
      ? `${primary} executes project code`
      : `${primary} may execute project code`;
    return classification("execute", reason, `shell.execute.${primary}`);
  },
};
