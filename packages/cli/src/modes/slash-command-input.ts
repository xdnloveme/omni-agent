export interface SlashCommandInput {
  readonly name: string;
  readonly args: string;
}

const SLASH_HEAD = /^\/([a-z0-9][a-z0-9_-]*)(?=$|\s)/i;

/**
 * Parses a slash-command head at column zero without interpreting message bodies or paths.
 */
export function parseSlashCommandInput(input: string): SlashCommandInput | null {
  if (input === "/") return { name: "help", args: "" };

  const match = SLASH_HEAD.exec(input);
  if (!match) return null;

  const name = (match[1] as string).toLowerCase();
  const args = input.slice(match[0].length).replace(/^\s+/, "");
  return { name, args };
}
