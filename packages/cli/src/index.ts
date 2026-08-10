import { parseCliArgs } from "./args";
import { runChatMode } from "./modes/chat";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.mode === "chat") await runChatMode(args.agentId);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
