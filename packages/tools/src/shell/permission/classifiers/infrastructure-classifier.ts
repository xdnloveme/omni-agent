import { classification, type ShellClassifier } from "./types";
import { commandName, subcommand } from "./command-utils";

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
  classify(words) {
    const primary = commandName(words);
    if (!INFRASTRUCTURE_COMMANDS.has(primary)) return null;
    const action = subcommand(words);
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
