import { stat } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import {
  EnvironmentContextError,
  throwIfAborted,
  type RuntimeEnvironmentProviderPort,
  type RuntimeEnvironmentSnapshot,
} from "@omni-agent/core";

export interface NodeRuntimeEnvironmentProviderOptions {
  readonly cwd: string;
  readonly workspaceRoots?: readonly string[];
  readonly now?: () => Date;
}

export class NodeRuntimeEnvironmentProvider implements RuntimeEnvironmentProviderPort {
  private readonly cwd: string;
  private readonly workspaceRoots: readonly string[];
  private readonly now: () => Date;

  constructor(options: NodeRuntimeEnvironmentProviderOptions) {
    this.cwd = resolve(options.cwd);
    this.workspaceRoots = (options.workspaceRoots ?? [options.cwd]).map((root) => resolve(root));
    this.now = options.now ?? (() => new Date());
  }

  async snapshot(signal?: AbortSignal): Promise<RuntimeEnvironmentSnapshot> {
    throwIfAborted(signal);
    await assertDirectory(this.cwd, "workspace.cwd");
    for (const root of this.workspaceRoots) await assertDirectory(root, "workspace.roots");
    throwIfAborted(signal);

    const timezone = resolveTimezone();
    return {
      workspace: { cwd: this.cwd, roots: [...this.workspaceRoots] },
      time: { currentDate: formatDate(this.now(), timezone), timezone },
      execution: {
        platform: normalizePlatform(platform()),
        arch: process.arch,
        shell: process.env.SHELL ?? process.env.ComSpec ?? "unknown",
        kind: "host",
      },
    };
  }
}

function resolveTimezone(): string {
  try {
    const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) throw new Error("Host timezone is unavailable");
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch (error) {
    throw new EnvironmentContextError({
      code: "environment_context_unavailable",
      message: "Unable to resolve the host timezone.",
      field: "time.timezone",
      retryable: true,
      cause: error,
    });
  }
}

function formatDate(date: Date, timezone: string): string {
  if (!Number.isFinite(date.getTime())) {
    throw new EnvironmentContextError({
      code: "environment_context_invalid",
      message: "The environment clock returned an invalid date.",
      field: "time.currentDate",
      retryable: false,
    });
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function assertDirectory(path: string, field: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) return;
  } catch (error) {
    throw new EnvironmentContextError({
      code: "environment_context_invalid",
      message: `${field} is not an accessible directory: ${path}`,
      field,
      retryable: false,
      cause: error,
    });
  }
  throw new EnvironmentContextError({
    code: "environment_context_invalid",
    message: `${field} is not a directory: ${path}`,
    field,
    retryable: false,
  });
}

function normalizePlatform(
  value: NodeJS.Platform,
): RuntimeEnvironmentSnapshot["execution"]["platform"] {
  return value === "darwin" || value === "linux" || value === "win32" ? value : "other";
}
