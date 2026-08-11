import path from "node:path";
import { shellWords } from "../shell-parser";

const SIMPLE_WRAPPERS = new Set(["command", "exec", "nohup", "time"]);

export function unwrapCommand(segment: string): string | null {
  const words = shellWords(segment);
  const commandIndex = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word));
  if (commandIndex < 0) return null;
  const primary = path.basename(words[commandIndex]!).toLowerCase();
  const args = words.slice(commandIndex + 1);
  if (primary === "env") {
    const nested = args.findIndex(
      (word) => !word.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word),
    );
    return nested < 0 ? null : args.slice(nested).join(" ");
  }
  if (SIMPLE_WRAPPERS.has(primary) || primary === "xargs") {
    const nested = args.findIndex((word) => !word.startsWith("-"));
    return nested < 0 ? null : args.slice(nested).join(" ");
  }
  if (["bash", "sh", "zsh", "dash"].includes(primary)) {
    const commandFlag = args.findIndex((word) => word === "-c");
    return commandFlag >= 0 && args[commandFlag + 1]
      ? args.slice(commandFlag + 1).join(" ")
      : segment;
  }
  return segment;
}
