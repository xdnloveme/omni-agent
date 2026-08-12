import {
  EXECUTE_COMMANDS,
  EXTERNAL_COMMANDS,
  INTERPRETER_COMMANDS,
  NETWORK_TRANSFER_COMMANDS,
  READ_ONLY_COMMANDS,
  SHELL_CONTEXT_COMMANDS,
} from "../rules/command-rules";
import { classification, type ShellClassifier } from "./types";

export const genericCommandClassifier: ShellClassifier = {
  priority: 100,
  classify(command) {
    const primary = command.executableName;
    if (SHELL_CONTEXT_COMMANDS.has(primary)) {
      return classification(
        "read",
        `${primary} changes shell-local context`,
        `shell.context.${primary}`,
      );
    }
    if (EXTERNAL_COMMANDS.has(primary)) {
      return classification(
        "external",
        `${primary} accesses external systems`,
        `shell.external.${primary}`,
        {
          effects: NETWORK_TRANSFER_COMMANDS.has(primary)
            ? [
                "network_transfer",
                ...(primary === "curl" || primary === "wget" ? ["download" as const] : []),
              ]
            : [],
        },
      );
    }
    if (EXECUTE_COMMANDS.has(primary)) {
      return classification(
        "execute",
        `${primary} executes local code`,
        `shell.execute.${primary}`,
        {
          effects: INTERPRETER_COMMANDS.has(primary) ? ["interpreter"] : [],
        },
      );
    }
    if (READ_ONLY_COMMANDS.has(primary)) {
      return classification("read", `${primary} is read-only`, `shell.read.${primary}`);
    }
    return null;
  },
};
