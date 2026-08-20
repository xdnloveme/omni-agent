import { isAgentId } from "@omni-agent/core";

export type CliCommand =
  | { readonly kind: "run"; readonly agentId: string; readonly trace: boolean }
  | { readonly kind: "trace-preview"; readonly agentId: string }
  | { readonly kind: "trace-clear"; readonly agentId: string; readonly confirmed: boolean }
  | { readonly kind: "doctor" }
  | { readonly kind: "help" }
  | { readonly kind: "version" };

export class CliUsageError extends Error {}

export function parseCliArgs(args: readonly string[]): CliCommand {
  const positional = args.filter((argument) => argument !== "--");
  const command = positional[0];
  if (command === undefined) return runCommand("coding", false);
  if (command === "--trace") {
    if (positional[1] !== undefined) {
      throw new CliUsageError(`Unexpected argument: ${positional[1]}`);
    }
    return runCommand("coding", true);
  }
  if (command === "--help" || command === "-h") return noTrailingArgs(positional, { kind: "help" });
  if (command === "--version" || command === "-v") {
    return noTrailingArgs(positional, { kind: "version" });
  }
  if (command === "doctor") return noTrailingArgs(positional, { kind: "doctor" });
  if (command === "trace") {
    const action = positional[1];
    const agentId = positional[2];
    if (action !== "preview" && action !== "clear") {
      throw new CliUsageError("Usage: omni trace preview|clear <agent-id>");
    }
    if (!agentId || !isAgentId(agentId)) throw new CliUsageError(`Invalid agent id: ${agentId}`);
    if (action === "preview") {
      if (positional[3] !== undefined) {
        throw new CliUsageError(`Unexpected argument: ${positional[3]}`);
      }
      return { kind: "trace-preview", agentId };
    }
    const trailing = positional.slice(3);
    if (trailing.some((argument) => argument !== "--yes")) {
      throw new CliUsageError(`Unexpected argument: ${trailing[0]}`);
    }
    return { kind: "trace-clear", agentId, confirmed: trailing.includes("--yes") };
  }
  if (command !== "run") throw new CliUsageError(`Unknown command: ${command}`);

  const runArgs = positional.slice(1);
  const traceArguments = runArgs.filter((argument) => argument === "--trace");
  if (traceArguments.length > 1) throw new CliUsageError("Duplicate option: --trace");
  const agentArguments = runArgs.filter((argument) => argument !== "--trace");
  const agentId = agentArguments[0] ?? "coding";
  if (!isAgentId(agentId)) throw new CliUsageError(`Invalid agent id: ${agentId}`);
  if (agentArguments[1] !== undefined) {
    throw new CliUsageError(`Unexpected argument: ${agentArguments[1]}`);
  }
  return runCommand(agentId, traceArguments.length === 1);
}

function runCommand(agentId: string, trace: boolean): CliCommand {
  return { kind: "run", agentId, trace };
}

function noTrailingArgs<T extends CliCommand>(args: readonly string[], command: T): T {
  if (args[1] !== undefined) throw new CliUsageError(`Unexpected argument: ${args[1]}`);
  return command;
}
