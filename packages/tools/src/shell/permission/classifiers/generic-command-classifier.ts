import {
  EXECUTE_COMMANDS,
  EXTERNAL_COMMANDS,
  NETWORK_TRANSFER_COMMANDS,
  READ_ONLY_COMMANDS,
} from "../rules/command-rules";
import { classification, type ShellClassifier } from "./types";
import { commandName } from "./command-utils";

export const genericCommandClassifier: ShellClassifier = {
  priority: 100,
  classify(words) {
    const primary = commandName(words);
    if (EXTERNAL_COMMANDS.has(primary)) {
      return classification(
        "external",
        `${primary} accesses external systems`,
        `shell.external.${primary}`,
        "policy",
        NETWORK_TRANSFER_COMMANDS.has(primary) ? ["network_transfer"] : [],
      );
    }
    if (EXECUTE_COMMANDS.has(primary)) {
      return classification(
        "execute",
        `${primary} executes local code`,
        `shell.execute.${primary}`,
      );
    }
    if (READ_ONLY_COMMANDS.has(primary)) {
      return classification("read", `${primary} is read-only`, `shell.read.${primary}`);
    }
    return null;
  },
};
