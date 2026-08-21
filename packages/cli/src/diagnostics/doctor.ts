import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { ConfigService, resolveWorkspaceContext } from "@omni-agent/app";
import { loadAgentPackage } from "../agents/agent-package-loader";

interface DoctorCheck {
  readonly name: string;
  run(): Promise<string>;
}

export interface DoctorOptions {
  readonly cwd?: string;
  readonly globalDirectory?: string;
  readonly nodeVersion?: string;
  readonly resolutionBase?: string;
  readonly agentPackagesDirectory?: string;
  readonly write?: (text: string) => void;
  readonly checks?: readonly DoctorCheck[];
}

export async function runDoctor(options: DoctorOptions = {}): Promise<boolean> {
  const cwd = options.cwd ?? ".";
  const globalDirectory = options.globalDirectory ?? ".omni-agent";
  const checks =
    options.checks ??
    createDoctorChecks(
      cwd,
      globalDirectory,
      options.nodeVersion ?? "unknown",
      options.resolutionBase,
      options.agentPackagesDirectory,
    );
  const write = options.write ?? (() => undefined);
  const results = await Promise.all(
    checks.map(async (check) => {
      try {
        return { ok: true, name: check.name, detail: await check.run() };
      } catch (error) {
        return {
          ok: false,
          name: check.name,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  write("Omni Agent Doctor\n\n");
  for (const result of results) {
    write(`${result.ok ? "✓" : "✗"} ${result.name}${result.detail ? `: ${result.detail}` : ""}\n`);
  }
  return results.every((result) => result.ok);
}

function createDoctorChecks(
  cwd: string,
  globalDirectory: string,
  nodeVersion: string,
  resolutionBase?: string,
  agentPackagesDirectory?: string,
): readonly DoctorCheck[] {
  let workspacePromise: ReturnType<typeof resolveWorkspaceContext> | undefined;
  const workspace = () => (workspacePromise ??= resolveWorkspaceContext(cwd));
  return [
    {
      name: "Node.js",
      async run() {
        if (!isSupportedNodeVersion(nodeVersion)) {
          throw new Error(`${nodeVersion} is unsupported; requires >=22.19.0`);
        }
        return nodeVersion;
      },
    },
    {
      name: "Workspace",
      async run() {
        const resolved = await workspace();
        return `${resolved.root} (${resolved.id})`;
      },
    },
    {
      name: "Global directory",
      async run() {
        await assertDirectoryAccessible(globalDirectory);
        return globalDirectory;
      },
    },
    {
      name: "Configuration",
      async run() {
        const resolved = await workspace();
        const service = new ConfigService({ cwd: resolved.root, globalDirectory });
        await service.resolveModelConfiguration("coding");
        if (service.diagnostics.length > 0) {
          throw new Error(service.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
        }
        return "valid";
      },
    },
    {
      name: "Coding agent",
      async run() {
        await loadAgentPackage("coding", { resolutionBase, agentPackagesDirectory });
        return "available";
      },
    },
    moduleCheck("keytar"),
    moduleCheck("tree-sitter"),
    moduleCheck("tree-sitter-bash"),
  ];
}

function moduleCheck(packageName: string): DoctorCheck {
  return {
    name: packageName,
    async run() {
      const require = createRequire(import.meta.url);
      require(require.resolve(packageName));
      return "available";
    },
  };
}

async function assertDirectoryAccessible(path: string): Promise<void> {
  let candidate = path;
  while (true) {
    try {
      if (!(await stat(candidate)).isDirectory()) {
        throw new Error(`Expected a directory: ${candidate}`);
      }
      await access(candidate, constants.R_OK | constants.W_OK | constants.X_OK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}
