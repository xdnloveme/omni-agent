import { classification, type ShellClassifier } from "./types";
import { findPositionalArgument } from "./command-utils";

const INFRASTRUCTURE_COMMANDS = new Set([
  "terraform",
  "helm",
  "aws",
  "gcloud",
  "az",
  "vercel",
  "netlify",
]);

export const infrastructureClassifier: ShellClassifier = {
  priority: 60,
  classify(command) {
    const primary = command.executableName;
    if (!INFRASTRUCTURE_COMMANDS.has(primary)) return null;
    const action = findPositionalArgument(command.argumentValues)?.value ?? "";
    if (primary === "terraform" && action === "destroy") {
      return classification(
        "destructive",
        "Destroys managed infrastructure",
        "shell.destructive.terraform",
      );
    }
    if (primary === "helm" && ["uninstall", "rollback"].includes(action)) {
      return classification("destructive", "Changes deployed releases", "shell.destructive.helm");
    }
    return classification(
      "external",
      `${primary} accesses external infrastructure`,
      `shell.external.${primary}`,
    );
  },
};
