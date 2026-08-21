import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { renderAgentScaffold } from "./template";

export interface CreateAgentScaffoldInput {
  readonly agentId: string;
  readonly directory: string;
  readonly frameworkVersion: string;
}

export interface CreatedAgentScaffold {
  readonly agentId: string;
  readonly directory: string;
  readonly files: readonly string[];
}

export class AgentScaffoldError extends Error {
  constructor(
    readonly code: "agent_scaffold_target_exists" | "agent_scaffold_write_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentScaffoldError";
  }
}

/** Owns one fail-closed filesystem transaction; it never overwrites an existing target. */
export async function createAgentScaffold(
  input: CreateAgentScaffoldInput,
): Promise<CreatedAgentScaffold> {
  const directory = resolve(input.directory);
  const files = renderAgentScaffold({
    agentId: input.agentId,
    displayName: displayNameFor(input.agentId),
    frameworkVersion: input.frameworkVersion,
  });
  try {
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AgentScaffoldError(
        "agent_scaffold_target_exists",
        `Agent scaffold target already exists: ${directory}`,
        { cause: error },
      );
    }
    throw new AgentScaffoldError(
      "agent_scaffold_write_failed",
      `Unable to create Agent scaffold target: ${directory}`,
      { cause: error },
    );
  }

  try {
    for (const file of files) {
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { flag: "wx" });
    }
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Agent scaffold creation and cleanup failed: ${directory}`,
      );
    }
    throw new AgentScaffoldError(
      "agent_scaffold_write_failed",
      `Unable to write Agent scaffold: ${directory}`,
      { cause: error },
    );
  }
  return { agentId: input.agentId, directory, files: files.map(({ path }) => path) };
}

function displayNameFor(agentId: string): string {
  return agentId
    .split(/[._-]/u)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
