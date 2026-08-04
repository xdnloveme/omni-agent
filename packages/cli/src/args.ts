export interface CliArgs {
  mode: "chat";
}

export function parseCliArgs(args: string[]): CliArgs {
  const mode = args[0] ?? "chat";
  if (mode !== "chat") throw new Error(`Unknown mode: ${mode}`);
  return { mode };
}
