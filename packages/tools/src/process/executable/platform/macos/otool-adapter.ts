import path from "node:path";
import { runHostProcess } from "../../../host-process-runner";
import { SandboxProcessError } from "../../../sandbox-process-error";

const MAX_OTOOL_OUTPUT_BYTES = 256 * 1024;

export interface MachOInspection {
  readonly dependencies: readonly string[];
  readonly rpaths: readonly string[];
}

export async function inspectMachO(
  imagePath: string,
  signal?: AbortSignal,
): Promise<MachOInspection> {
  const [libraries, commands] = await Promise.all([
    runOtool(["-L", imagePath], imagePath, signal),
    runOtool(["-l", imagePath], imagePath, signal),
  ]);
  return {
    dependencies: libraries
      .split("\n")
      .slice(1)
      .map((line) => line.trim().match(/^(\S+)\s+\(compatibility version/)?.[1])
      .filter((value): value is string => Boolean(value)),
    rpaths: parseRpaths(commands),
  };
}

async function runOtool(
  arguments_: readonly string[],
  imagePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runHostProcess({
    command: "/usr/bin/otool",
    args: arguments_,
    cwd: path.dirname(imagePath),
    signal,
    maxOutputBytes: MAX_OTOOL_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0 || result.signal || result.stdoutTruncated || result.stderrTruncated) {
    throw new SandboxProcessError(
      "sandbox_runtime_dependency_unresolved",
      "Unable to inspect the executable's Mach-O dependency metadata.",
    );
  }
  return result.stdout;
}

function parseRpaths(output: string): readonly string[] {
  const lines = output.split("\n");
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "cmd LC_RPATH") continue;
    for (let cursor = index + 1; cursor < Math.min(index + 6, lines.length); cursor += 1) {
      const value = lines[cursor]?.trim().match(/^path (.+) \(offset \d+\)$/)?.[1];
      if (value) {
        values.push(value);
        break;
      }
    }
  }
  return [...new Set(values)];
}
